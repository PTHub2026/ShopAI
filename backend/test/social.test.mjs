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
