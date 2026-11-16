import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sqliteDB} from './sqlite-fixture.mjs';
import {encryptToken,decryptToken,SOCIAL_SCHEMA,ensureSocialSchema,handleSocial,runDuePublishJobs} from '../src/social.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const key=()=>Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64');
test('token encrypted at rest, unique IV, decryptable with configured key',async()=>{
 const env={SOCIAL_TOKEN_KEY:key()},token='123456789:TEST_SECRET_TOKEN_NEVER_STORE_PLAINTEXT';
 const a=await encryptToken(env,token),b=await encryptToken(env,token);
 assert.notEqual(a.cipher,token);assert.notEqual(a.cipher,b.cipher);assert.notEqual(a.iv,b.iv);
 assert.equal(await decryptToken(env,a.cipher,a.iv),token);
 await assert.rejects(decryptToken({SOCIAL_TOKEN_KEY:key()},a.cipher,a.iv));
});
test('missing encryption key fails closed',async()=>{
 await assert.rejects(encryptToken({},'test'));
 const response=await handleSocial(new Request('https://example.com/api/social/accounts'),{DB:{}},{owner:'user'},(v,s=200)=>new Response(JSON.stringify(v),{status:s}));
 assert.equal(response.status,503);
 assert.equal((await response.json()).code,'social_key_missing');
});
test('schema enforces per-shop idempotency and scoped accounts',()=>{
 const s=SOCIAL_SCHEMA.join('\n');
 assert.match(s,/UNIQUE\(shop_id,idempotency_key\)/);
 assert.match(s,/UNIQUE\(shop_id,provider,target_id\)/);
 assert.match(s,/CHECK\(status IN \('pending','sending','sent','retryable','unknown','failed'\)\)/);
 const migration=readFileSync(new URL('../migrations/0008_social_publishing.sql',import.meta.url),'utf8');
 assert.match(migration,/UNIQUE\(shop_id,idempotency_key\)/);
 assert.match(migration,/UNIQUE\(shop_id,provider,target_id\)/);
});
test('publisher safeguards: shop scoping, conditional claim and unknown no replay',()=>{
 const source=readFileSync(new URL('../src/social.js',import.meta.url),'utf8');
 assert.match(source,/resolveShop\(env,who,req\)/);
 assert.match(source,/WHERE shop_id=\? AND id=\?/);
 assert.match(source,/status IN \('pending','retryable'\)/);
 assert.match(source,/delivery_uncertain/);
 assert.match(source,/status='revoked',token='',token_iv=''/);
 assert.doesNotMatch(source,/console\.log\([^)]*token/);
});
test('runDuePublishJobs only recovers stale sending jobs without replaying them',async()=>{
 const DB=sqliteDB();
 try{
  DB.sqlite.exec(readFileSync(new URL('../migrations/0006_scheduled.sql',import.meta.url),'utf8'));
  await ensureSocialSchema(DB);
  const t=Math.floor(Date.now()/1000);
  DB.sqlite.prepare("INSERT INTO shops (id,name,owner,created_at,updated_at) VALUES ('shop','Test shop','user',?,?)").run(t,t);
  const insert=DB.sqlite.prepare(`INSERT INTO publish_jobs
   (id,shop_id,account_id,idempotency_key,kind,payload,status,created_by,created_at,updated_at)
   VALUES (?,'shop','account',?,'text','{}',?,'user',?,?)`);
  insert.run('stuck','stuck','sending',t-400,t-400);
  insert.run('fresh','fresh','sending',t,t);
  insert.run('sent','sent','sent',t-400,t-400);

  assert.deepEqual(await runDuePublishJobs({DB}),{processed:0});
  const job=DB.sqlite.prepare('SELECT status,error_code,updated_at FROM publish_jobs WHERE id=?');
  assert.equal(job.get('stuck').status,'unknown');
  assert.equal(job.get('stuck').error_code,'sending_interrupted');
  assert.equal(job.get('fresh').status,'sending');
  assert.equal(job.get('fresh').updated_at,t);
  assert.equal(job.get('sent').status,'sent');
  assert.equal(job.get('sent').updated_at,t-400);
  assert.deepEqual(await runDuePublishJobs({DB}),{processed:0});
 }finally{DB.sqlite.close();}
});
test('manual retry resets unknown+sending_interrupted job to pending, leaves other statuses unchanged',async()=>{
 const DB=sqliteDB();
 try{
  DB.sqlite.exec(readFileSync(new URL('../migrations/0006_scheduled.sql',import.meta.url),'utf8'));
  await ensureSocialSchema(DB);
  const t=Math.floor(Date.now()/1000);
  // Set up shop + membership so resolveShop can resolve 'user' to shop via defaultMembership.
  // Shop ID must match /^s_[A-Za-z0-9_-]{8,32}$/ for X-ShopPost-Shop header; use defaultMembership instead.
  const shopId='s_testshop';
  DB.sqlite.prepare("INSERT INTO shops (id,name,owner,status,created_at,updated_at) VALUES (?,?,?,'active',?,?)").run(shopId,'Test shop','user',t,t);
  DB.sqlite.prepare("INSERT INTO shop_members (shop_id,user_id,role,can_publish,created_at) VALUES (?,?,'owner',1,?)").run(shopId,'user',t);
  DB.sqlite.prepare("INSERT INTO channels (id,shop_id,provider,external_id,name,token,token_iv,status,connected_by,created_at,updated_at) VALUES ('ch1',?,'telegram','tg1','TG','tok','iv','connected','user',?,?)").run(shopId,t,t);
  const insert=DB.sqlite.prepare(`INSERT INTO publish_jobs (id,shop_id,account_id,idempotency_key,kind,payload,status,error_code,created_by,created_at,updated_at) VALUES (?,?,'ch1',?,'text','{}',?,?,'user',?,?)`);
  insert.run('j_unknown',shopId,'uk1','unknown','sending_interrupted',t,t);
  insert.run('j_failed',shopId,'fk1','failed','other_error',t,t);
  insert.run('j_sent',shopId,'sk1','sent',null,t,t);

  const json=(v,s=200)=>({status:s,data:v});
  // SOCIAL_TOKEN_KEY must be a valid base64-encoded 32-byte key
  const env={DB,SOCIAL_TOKEN_KEY:Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64')};
  const who={owner:'user'};
  // No X-ShopPost-Shop header: defaultMembership resolves to the only active shop for 'user'

  // Manual retry of unknown+sending_interrupted → resets to pending, then deliver() runs (account_revoked since no real Telegram)
  const req1=new Request('https://x.com/api/social/jobs/j_unknown/retry',{method:'POST'});
  await handleSocial(req1,env,who,json);
  // Job must no longer be in 'unknown' state — the fix allowed deliver() to run
  const after1=DB.sqlite.prepare('SELECT status FROM publish_jobs WHERE id=?').get('j_unknown');
  assert.notEqual(after1.status,'unknown','unknown+sending_interrupted job must escape stuck state after manual retry');

  // Manual retry of failed+other_error → deliver() returns 409 immediately (not reset by the fix)
  const req2=new Request('https://x.com/api/social/jobs/j_failed/retry',{method:'POST'});
  const r2=await handleSocial(req2,env,who,json);
  assert.equal(r2.status,409);
  assert.equal(DB.sqlite.prepare('SELECT status FROM publish_jobs WHERE id=?').get('j_failed').status,'failed');

  // Manual retry of sent → deliver() returns 200 immediately, status stays 'sent'
  const req3=new Request('https://x.com/api/social/jobs/j_sent/retry',{method:'POST'});
  const r3=await handleSocial(req3,env,who,json);
  assert.equal(r3.status,200);
  assert.equal(DB.sqlite.prepare('SELECT status FROM publish_jobs WHERE id=?').get('j_sent').status,'sent');
 }finally{DB.sqlite.close();}
});

test('manual retry resets unknown+delivery_uncertain job to pending (Zalo verify failure recovery)',async()=>{
 const DB=sqliteDB();
 try{
  DB.sqlite.exec(readFileSync(new URL('../migrations/0006_scheduled.sql',import.meta.url),'utf8'));
  await ensureSocialSchema(DB);
  const t=Math.floor(Date.now()/1000);
  const shopId='s_testshop2';
  DB.sqlite.prepare("INSERT INTO shops (id,name,owner,status,created_at,updated_at) VALUES (?,?,?,'active',?,?)").run(shopId,'Test shop 2','user2',t,t);
  DB.sqlite.prepare("INSERT INTO shop_members (shop_id,user_id,role,can_publish,created_at) VALUES (?,?,'owner',1,?)").run(shopId,'user2',t);
  DB.sqlite.prepare("INSERT INTO channels (id,shop_id,provider,external_id,name,token,token_iv,status,connected_by,created_at,updated_at) VALUES ('ch2',?,'telegram','tg2','TG2','tok','iv','connected','user2',?,?)").run(shopId,t,t);
  const insert=DB.sqlite.prepare(`INSERT INTO publish_jobs (id,shop_id,account_id,idempotency_key,kind,payload,status,error_code,created_by,created_at,updated_at) VALUES (?,?,'ch2',?,'text','{}',?,?,'user2',?,?)`);
  // Simulate a Zalo publish job stuck in unknown+delivery_uncertain (verify call failed after article create)
  insert.run('j_du',shopId,'du1','unknown','delivery_uncertain',t,t);
  // A job with unknown status but a different error_code must NOT be reset
  insert.run('j_other',shopId,'du2','unknown','other_unknown_code',t,t);

  const json=(v,s=200)=>({status:s,data:v});
  const env={DB,SOCIAL_TOKEN_KEY:Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64')};
  const who={owner:'user2'};

  // Manual retry of unknown+delivery_uncertain → resets to pending, then deliver() runs (account_revoked since no real Telegram)
  const req1=new Request('https://x.com/api/social/jobs/j_du/retry',{method:'POST'});
  await handleSocial(req1,env,who,json);
  const after1=DB.sqlite.prepare('SELECT status FROM publish_jobs WHERE id=?').get('j_du');
  assert.notEqual(after1.status,'unknown','unknown+delivery_uncertain job must escape stuck state after manual retry');

  // Manual retry of unknown+other_unknown_code → deliver() returns 409 (not reset, status stays unknown)
  const req2=new Request('https://x.com/api/social/jobs/j_other/retry',{method:'POST'});
  const r2=await handleSocial(req2,env,who,json);
  assert.equal(r2.status,409);
  assert.equal(DB.sqlite.prepare('SELECT status FROM publish_jobs WHERE id=?').get('j_other').status,'unknown');
 }finally{DB.sqlite.close();}
});
