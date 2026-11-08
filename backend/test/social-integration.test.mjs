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
 const env={DB:db,ACCESS_TEAM_DOMAIN:'test-team.cloudflareaccess.com',ACCESS_AUD:'test',AI:{},AI_RATE_LIMITER:{},SOCIAL_TOKEN_KEY:Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64')};
 function login(owner){
  const token=Buffer.from(owner+':'+crypto.randomUUID()).toString('base64url').slice(0,43).padEnd(43,'A');
  db.sqlite.prepare('INSERT OR IGNORE INTO auth_identities(owner,provider,created_at,last_login_at) VALUES(?,?,?,?)').run(owner,'email',now(),now());
  db.sqlite.prepare('INSERT INTO auth_sessions(token_hash,owner,provider,created_at,expires_at) VALUES(?,?,?,?,?)').run(hash(token),owner,'email',now(),now()+3600);
  return SESSION_COOKIE+'='+token;
 }
 async function request(cookie,path,{method='GET',body,shop,idem}={}){
  const r=await worker.fetch(new Request(base+path,{method,headers:{Cookie:cookie,Origin:base,...(body?{'Content-Type':'application/json'}:{}),...(shop?{'X-ShopPost-Shop':shop}:{}),...(idem?{'Idempotency-Key':idem}:{})},...(body?{body:JSON.stringify(body)}:{})}),env);
  return {status:r.status,data:await r.json()};
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
  assert.equal(f.db.sqlite.prepare('SELECT token_ciphertext FROM social_accounts WHERE id=?').get(account.id).token_ciphertext,'');
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
  const retried=await f.request(owner,'/api/social/jobs/'+jobId+'/retry',{method:'POST'});
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
