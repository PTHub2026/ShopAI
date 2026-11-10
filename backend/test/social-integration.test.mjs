import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto,createHash} from 'node:crypto';
import worker from '../src/worker.js';
import {SESSION_COOKIE} from '../src/auth.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const base='https://shoppost.example',hash=x=>createHash('sha256').update(x).digest('hex'),now=()=>Math.floor(Date.now()/1000);
const botToken='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg';
function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 for(const file of ['0001_drafts.sql','0002_auth.sql'])sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const prepare=(sql,p=[])=>({bind:(...args)=>prepare(sql,args),async first(){return sqlite.prepare(sql).get(...p)||null;},async all(){return {results:sqlite.prepare(sql).all(...p)};},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...p).changes)}};},exec(){return {meta:{changes:Number(sqlite.prepare(sql).run(...p).changes)}};}});
 const db={sqlite,prepare:sql=>prepare(sql),async batch(stmts){sqlite.exec('BEGIN');try{const out=stmts.map(s=>s.exec());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const env={DB:db,ACCESS_TEAM_DOMAIN:'test-team.cloudflareaccess.com',ACCESS_AUD:'test',AI:{},AI_RATE_LIMITER:{limit:async()=>({success:true})},SOCIAL_TOKEN_KEY:Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64')};
 function login(owner){
  const token=Buffer.from(owner+':'+crypto.randomUUID()).toString('base64url').slice(0,43).padEnd(43,'A');
  db.sqlite.prepare('INSERT OR IGNORE INTO auth_identities(owner,provider,created_at,last_login_at) VALUES(?,?,?,?)').run(owner,'email',now(),now());
  db.sqlite.prepare('INSERT INTO auth_sessions(token_hash,owner,provider,created_at,expires_at) VALUES(?,?,?,?,?)').run(hash(token),owner,'email',now(),now()+3600);
  return SESSION_COOKIE+'='+token;
 }
 async function request(cookie,path,{method='GET',body,shop,idem}={}){
  const r=await worker.fetch(new Request(base+path,{method,headers:{Cookie:cookie,Origin:base,...(body?{'Content-Type':'application/json'}:{}),...(shop?{'X-ShopPost-Shop':shop}:{}),...(idem?{'Idempotency-Key':idem}:{})},...(body?{body:JSON.stringify(body)}:{})}),env);
  return {status:r.status,headers:r.headers,data:await r.json()};
 }
 return {db,env,login,request};
}
async function fakeTelegram(fn,callback){
 const original=globalThis.fetch;globalThis.fetch=async(url,options)=>{
  const u=String(url);assert.ok(u.startsWith('https://api.telegram.org/bot'),'Unexpected external request');
  const method=u.split('/').at(-1),body=JSON.parse(options.body);
  if(method==='getMe')return Response.json({ok:true,result:{is_bot:true,username:'test_bot'}});
  if(method==='getChat')return Response.json({ok:true,result:{id:-1001000123456,title:'Test channel'}});
  return fn(method,body);
 };
 try{return await callback();}finally{globalThis.fetch=original;}
}
const connect=(r,c)=>r(c,'/api/social/accounts',{method:'POST',body:{token:botToken,chatId:'@testchannel'}});
test('Telegram live: per-shop permissions, idempotency, revoked credentials and photo publishing',async()=>{
 const f=fixture(),owner=f.login('email:owner@example.com'),other=f.login('email:other@example.com');
 let messages=0;
 await fakeTelegram((method,body)=>{messages++;assert.ok(['sendMessage','sendPhoto'].includes(method));assert.equal(body.chat_id,'-1001000123456');return Response.json({ok:true,result:{message_id:messages}});},async()=>{
  assert.equal((await connect(f.request,owner)).status,201);
  const list=await f.request(owner,'/api/social/accounts');assert.equal(list.status,200);
  const account=list.data.accounts[0];assert.ok(account.id);
  assert.equal(JSON.stringify(list.data).includes(botToken),false);
  const otherShop=(await f.request(other,'/session')).data.shop.id;
  assert.equal((await f.request(other,'/api/social/accounts',{shop:otherShop})).data.accounts.length,0);
  assert.equal((await f.request(other,'/api/social/jobs',{method:'POST',body:{accountId:account.id,idempotencyKey:'other-shop-key-123',kind:'text',text:'Not mine'},shop:otherShop})).status,404);
  const currentShop=(await f.request(owner,'/session')).data.shop.id;
  const message={accountId:account.id,kind:'text',text:'Hello from test'};
  const first=await f.request(owner,'/api/social/jobs',{method:'POST',idem:'text-send-test-1234',body:message});
  assert.equal(first.status,200);assert.equal(first.data.job.status,'sent');assert.equal(messages,1);
  const repeat=await f.request(owner,'/api/social/jobs',{method:'POST',idem:'text-send-test-1234',body:message});
  assert.equal(repeat.status,200);assert.equal(messages,1,'duplicate key never republishes');
  assert.equal((await f.request(owner,'/api/social/jobs',{method:'POST',idem:'text-send-test-1234',body:{...message,text:'changed'}})).status,409);
  const photo=await f.request(owner,'/api/social/jobs',{method:'POST',idem:'photo-send-test-1234',body:{accountId:account.id,kind:'photo',text:'Caption',photoUrl:'https://example.com/public-photo.jpg'}});
  assert.equal(photo.status,200);assert.equal(messages,2);
  // A viewer can list but cannot publish or configure.
  f.db.sqlite.prepare('INSERT INTO shop_members(shop_id,user_id,role,can_publish,created_at) VALUES(?,?,?,?,?)').run(currentShop,'email:other@example.com','viewer',0,now());
  assert.equal((await f.request(other,'/api/social/accounts',{shop:currentShop})).status,200);
  assert.equal((await f.request(other,'/api/social/jobs',{shop:currentShop,method:'POST',idem:'viewer-test-1234',body:message})).status,403);
  assert.equal((await f.request(other,'/api/social/accounts',{shop:currentShop,method:'POST',body:{token:botToken,chatId:'@testchannel'}})).status,403);
  assert.equal((await f.request(owner,'/api/social/accounts/'+account.id,{method:'DELETE'})).status,200);
  assert.equal((await f.request(owner,'/api/social/accounts')).data.accounts[0].status,'revoked');
  assert.equal(f.db.sqlite.prepare('SELECT token FROM channels WHERE id=?').get(account.id).token,'');
  assert.equal((await f.request(owner,'/api/social/jobs',{method:'POST',idem:'after-revoke-1234',body:message})).status,404);
 });
 f.db.sqlite.close();
});
test('Telegram 429 is retryable; unknown outcomes never retry automatically',async()=>{
 const f=fixture(),owner=f.login('email:retry@example.com');
 let called=0;
 await fakeTelegram((method,body)=>{called++;if(called===1)return Response.json({ok:false,description:'Too Many Requests',parameters:{retry_after:2}},{status:429});if(called===2)return Response.json({ok:true,result:{message_id:99}});throw Error('network timeout');},async()=>{
  assert.equal((await connect(f.request,owner)).status,201);
  const account=(await f.request(owner,'/api/social/accounts')).data.accounts[0];
  const data={accountId:account.id,kind:'text',text:'Retry once'};
  const throttled=await f.request(owner,'/api/social/jobs',{method:'POST',idem:'retry-test-key-123',body:data});
  assert.equal(throttled.status,429);assert.equal(throttled.data.job.status,'retryable');
  const jobId=throttled.data.job.id;
  const early=await f.request(owner,'/api/social/jobs/'+jobId+'/retry',{method:'POST'});
  assert.ok(Number(early.headers.get('Retry-After'))>0);
  assert.equal((await f.request(owner,'/api/social/jobs',{method:'POST',idem:'retry-test-key-123',body:data})).status,429);
  assert.equal(early.status,429);assert.equal(called,1,'retry_after must block early delivery');
  f.db.sqlite.prepare('UPDATE publish_jobs SET next_attempt_at=0 WHERE id=?').run(jobId);
  const manager=f.login('email:manager@example.com');
  const shopId=(await f.request(owner,'/session')).data.shop.id;
  f.db.sqlite.prepare('INSERT INTO shop_members(shop_id,user_id,role,can_publish,created_at) VALUES(?,?,?,?,?)').run(shopId,'email:manager@example.com','manager',0,now());
  const retried=await f.request(manager,'/api/social/jobs/'+jobId+'/retry',{method:'POST',shop:shopId});
  assert.equal(f.db.sqlite.prepare("SELECT actor FROM audit_log WHERE action='social.publish' ORDER BY id DESC LIMIT 1").get().actor,'email:manager@example.com');
  assert.equal(f.db.sqlite.prepare('SELECT created_by FROM publish_jobs WHERE id=?').get(jobId).created_by,'email:retry@example.com');
  assert.equal(retried.status,200);assert.equal(retried.data.job.status,'sent');assert.equal(called,2);
  const redundant=await f.request(owner,'/api/social/jobs/'+jobId+'/retry',{method:'POST'});
  assert.equal(redundant.status,200);assert.equal(called,2);
  const unknown=await f.request(owner,'/api/social/jobs',{method:'POST',idem:'unknown-test-key-123',body:{...data,text:'Unknown'}});
  assert.equal(unknown.status,502);assert.equal(unknown.data.job.status,'unknown');
  assert.equal((await f.request(owner,'/api/social/jobs/'+unknown.data.job.id+'/retry',{method:'POST'})).status,409);
  assert.equal(called,3);
 });
 f.db.sqlite.close();
});

test('Telegram malformed success remains unknown and cannot be retried',async()=>{
 const f=fixture(),owner=f.login('email:malformed@example.com');let calls=0;
 try{await fakeTelegram(()=>{calls++;return Response.json({ok:true,result:{}});},async()=>{
  await connect(f.request,owner);
  const account=(await f.request(owner,'/api/social/accounts')).data.accounts[0];
  const result=await f.request(owner,'/api/social/jobs',{method:'POST',idem:'malformed-result-123',body:{accountId:account.id,kind:'text',text:'Test'}});
  assert.equal(result.status,502);assert.equal(result.data.job.status,'unknown');
  assert.equal(result.data.job.remoteMessageId,null);
  assert.equal((await f.request(owner,'/api/social/jobs/'+result.data.job.id+'/retry',{method:'POST'})).status,409);
  assert.equal(calls,1);
 });}finally{f.db.sqlite.close();}
});

test('unified channel API stores Telegram in channels and schedules into common publish_jobs',async()=>{
 const f=fixture(),owner=f.login('email:unified@example.com');
 await fakeTelegram(()=>Response.json({ok:true,result:{message_id:123}}),async()=>{
  const r=await f.request(owner,'/channels/telegram/connect',{method:'POST',body:{token:botToken,chatId:'@testchannel'}});assert.equal(r.status,201);
  const list=await f.request(owner,'/channels/telegram/accounts');assert.equal(list.status,200);const a=list.data.accounts[0];
  assert.equal(f.db.sqlite.prepare('SELECT provider FROM channels WHERE id=?').get(a.id).provider,'telegram');
  const queued=await f.request(owner,'/channels/telegram/schedule',{method:'POST',idem:'unified-scheduled-123',body:{accountId:a.id,kind:'text',text:'Due soon',runAt:now()+60}});
  assert.equal(queued.status,201);assert.equal(queued.data.job.status,'pending');
  f.db.sqlite.prepare('UPDATE publish_jobs SET next_attempt_at=0 WHERE id=?').run(queued.data.job.id);
  const {runDueScheduledPosts}=await import('../src/channels.js');await runDueScheduledPosts(f.env);
  assert.equal(f.db.sqlite.prepare('SELECT status FROM publish_jobs WHERE id=?').get(queued.data.job.id).status,'sent');
 });
});
test('unified API rejects cross-provider publish and Instagram text without remote sends',async()=>{
 const f=fixture(),owner=f.login('email:unified-validate@example.com');
 await fakeTelegram(()=>{throw Error('Must not send');},async()=>{
  await connect(f.request,owner);const a=(await f.request(owner,'/api/social/accounts')).data.accounts[0];
  const r=await f.request(owner,'/channels/facebook/publish',{method:'POST',idem:'provider-mismatch-123',body:{accountId:a.id,kind:'text',text:'Wrong provider'}});assert.equal(r.status,404);
 });
});

test('job long-poll returns a shop-scoped cursor and detects changes without exposing payload or token',async()=>{
 const f=fixture(),owner=f.login('email:events@example.com'),other=f.login('email:events-other@example.com');
 await fakeTelegram(()=>Response.json({ok:true,result:{message_id:88}}),async()=>{
  await connect(f.request,owner);const a=(await f.request(owner,'/api/social/accounts')).data.accounts[0];
  await f.request(owner,'/channels/telegram/schedule',{method:'POST',idem:'events-test-key-123',body:{accountId:a.id,kind:'text',text:'PRIVATE PAYLOAD',runAt:now()+500}});
  const first=await f.request(owner,'/channels/all/jobs/events?wait=0');assert.equal(first.status,200);assert.equal(first.data.jobs.length,1);assert.ok(first.data.cursor);
  assert.equal(JSON.stringify(first.data).includes('PRIVATE PAYLOAD'),false);assert.equal(JSON.stringify(first.data).includes(botToken),false);
  const initial=first.data.cursor;
  setTimeout(()=>f.db.sqlite.prepare("UPDATE publish_jobs SET status='sent',remote_message_id='88' WHERE id=?").run(first.data.jobs[0].id),20);
  const next=await f.request(owner,'/channels/all/jobs/events?wait=2&cursor='+initial);assert.equal(next.status,200);assert.notEqual(next.data.cursor,initial);assert.equal(next.data.jobs[0].status,'sent');
  const isolated=await f.request(other,'/channels/all/jobs/events?wait=0');assert.equal(isolated.data.jobs.length,0);
  const shop=(await f.request(owner,'/session')).data.shop.id;
  assert.equal((await f.request(other,'/channels/all/jobs/events?wait=0',{shop})).status,404);
 });
});

test('publish-now operates the existing scheduled job and cannot duplicate it',async()=>{
 const f=fixture(),owner=f.login('email:run-existing@example.com');let sent=0;
 await fakeTelegram(()=>{sent++;return Response.json({ok:true,result:{message_id:77}});},async()=>{
  await connect(f.request,owner);const a=(await f.request(owner,'/api/social/accounts')).data.accounts[0];
  const q=await f.request(owner,'/channels/telegram/schedule',{method:'POST',idem:'run-existing-job-123',body:{accountId:a.id,kind:'text',text:'Run now',runAt:now()+3600}});
  const path='/channels/all/jobs/'+q.data.job.id+'/run';
  assert.equal((await f.request(owner,path,{method:'POST'})).data.job.status,'sent');
  assert.equal((await f.request(owner,path,{method:'POST'})).data.job.status,'sent');assert.equal(sent,1);
 });
});

test('social mutations share the fail-closed API write limiter before any writes or Telegram calls',async()=>{
 const f=fixture(),owner=f.login('email:limited@example.com');
 await f.request(owner,'/session');
 for(const [limiter,status] of [[undefined,503],[{limit:async()=>({})},503],[{limit:async()=>{throw Error('offline')}},503],[{limit:async({key})=>{assert.equal(key,'api-write:email:limited@example.com');return {success:false}}},429]]){
  f.env.AI_RATE_LIMITER=limiter;
  for(const path of ['accounts','jobs','jobs/missing/retry'])assert.equal((await f.request(owner,'/api/social/'+path,{method:'POST',body:{}})).status,status);
 }
 assert.equal(f.db.sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE name='publish_jobs'").get().n,0);
 f.db.sqlite.close();
});
test('concurrent identical jobs call Telegram once and isolate retry by shop',async()=>{
 const f=fixture(),owner=f.login('email:race@example.com'),other=f.login('email:outside@example.com');let calls=0,release,started;
 const entered=new Promise(r=>started=r),gate=new Promise(r=>release=r);
 await fakeTelegram(async()=>{calls++;started();await gate;return Response.json({ok:true,result:{message_id:7}})},async()=>{
  await connect(f.request,owner);
  const account=(await f.request(owner,'/api/social/accounts')).data.accounts[0];
  const options={method:'POST',idem:'concurrent-key-123',body:{accountId:account.id,kind:'text',text:'Race'}};
  const first=f.request(owner,'/api/social/jobs',options);await entered;
  const second=await f.request(owner,'/api/social/jobs',options);assert.equal(second.status,409);assert.equal(calls,1);
  release();const sent=await first;
  assert.equal((await f.request(other,'/api/social/jobs/'+sent.data.job.id+'/retry',{method:'POST'})).status,404);
  assert.equal((await f.request(owner,'/api/social/jobs/'+sent.data.job.id+'/retry',{method:'POST'})).status,200);assert.equal(calls,1);
 });f.db.sqlite.close();
});
