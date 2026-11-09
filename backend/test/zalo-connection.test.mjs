import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto,createHash} from 'node:crypto';
import worker from '../src/worker.js';
import {SESSION_COOKIE} from '../src/auth.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const base='https://shoppost.example';
const now=()=>Math.floor(Date.now()/1000);
function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 for(const file of ['0001_drafts.sql','0002_auth.sql'])sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const stmt=(sql,p=[])=>({bind:(...a)=>stmt(sql,a),async first(){return sqlite.prepare(sql).get(...p)||null;},async all(){return {results:sqlite.prepare(sql).all(...p)};},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...p).changes)}};},exec(){return {meta:{changes:Number(sqlite.prepare(sql).run(...p).changes)}};}});
 const DB={sqlite,prepare:s=>stmt(s),async batch(stmts){sqlite.exec('BEGIN');try{const v=stmts.map(x=>x.exec());sqlite.exec('COMMIT');return v;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const env={DB,AI:{},AI_RATE_LIMITER:{},ACCESS_TEAM_DOMAIN:'test-team.cloudflareaccess.com',ACCESS_AUD:'test',SOCIAL_TOKEN_KEY:Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64'),ZALO_APP_ID:'3847703053447967855',ZALO_APP_SECRET:'fixture-app-secret'};
 function login(owner){
  const t=Buffer.from(owner+':'+crypto.randomUUID()).toString('base64url').slice(0,43).padEnd(43,'A');
  sqlite.prepare('INSERT OR IGNORE INTO auth_identities(owner,provider,created_at,last_login_at) VALUES(?,?,?,?)').run(owner,'email',now(),now());
  sqlite.prepare('INSERT INTO auth_sessions(token_hash,owner,provider,created_at,expires_at) VALUES(?,?,?,?,?)').run(createHash('sha256').update(t).digest('hex'),owner,'email',now(),now()+3600);
  return SESSION_COOKIE+'='+t;
 }
 async function req(cookie,path,method='GET'){
  return worker.fetch(new Request(base+path,{method,headers:{Cookie:cookie,Origin:base,...(method==='POST'?{'Content-Type':'application/json'}:{})},...(method==='POST'?{body:'{}'}:{})}),env);
 }
 return {env,sqlite,login,req};
}
const access='fixture-access-only',refresh='fixture-refresh-only';
async function begin(f,cookie){
 const r=await f.req(cookie,'/channels/zalo/connect');assert.equal(r.status,302);
 const u=new URL(r.headers.get('Location'));
 return {cookie:cookie+'; '+r.headers.get('Set-Cookie').split(';')[0],url:base+'/auth/zalo/callback?code=fixture-code&state='+u.searchParams.get('state')};
}
async function callback(f,start){return worker.fetch(new Request(start.url,{headers:{Cookie:start.cookie}}),f.env);}
async function mocked(fn,run){const original=globalThis.fetch;globalThis.fetch=fn;try{await run();}finally{globalThis.fetch=original;}}
const graph=async url=>String(url).includes('access_token')?Response.json({access_token:access,refresh_token:refresh,expires_in:90000}):Response.json({error:0,data:{oa_id:'123456789',name:'Test OA'}});
test('Zalo connection is single-use, encrypts tokens, and creates no login session',async()=>{
 const f=fixture(),owner=f.login('email:owner@example.com'),start=await begin(f,owner);
 try{await mocked(graph,async()=>{
  const count=f.sqlite.prepare('SELECT count(*) n FROM auth_sessions').get().n;
  assert.equal((await callback(f,start)).headers.get('Location'),base+'/?connected=zalo#accounts');
  const row=f.sqlite.prepare('SELECT * FROM channels').get();
  assert.notEqual(row.token,access);assert.notEqual(row.refresh_token,refresh);
  const second=await callback(f,start);assert.match(second.headers.get('Location'),/connect_error=/);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM auth_sessions').get().n,count);
 });}finally{f.sqlite.close();}
});
test('Zalo never connects when OA information cannot be verified',async()=>{
 const f=fixture(),owner=f.login('email:owner@example.com'),start=await begin(f,owner);
 try{await mocked(async url=>String(url).includes('access_token')?graph(url):Response.json({error:-201,message:'denied'},{status:403}),async()=>{
  const r=await callback(f,start);assert.match(r.headers.get('Location'),/connect_error=/);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM channels').get().n,0);
 });}finally{f.sqlite.close();}
});
test('Zalo callback rejects another actor and expired state',async()=>{
 const f=fixture(),owner=f.login('email:owner@example.com'),other=f.login('email:other@example.com'),start=await begin(f,owner);
 try{await mocked(()=>{throw Error('Provider must not be contacted');},async()=>{
  const switched={...start,cookie:other+'; '+start.cookie.split('; ').at(-1)};
  assert.match((await callback(f,switched)).headers.get('Location'),/connect_error=/);
  f.sqlite.prepare('UPDATE channel_oauth_states SET expires_at=0').run();
  assert.match((await callback(f,start)).headers.get('Location'),/connect_error=/);
 });}finally{f.sqlite.close();}
});
test('Zalo refresh is serialized and stored rotated tokens are reusable without refreshing again',async()=>{
 const f=fixture(),owner=f.login('email:owner@example.com'),start=await begin(f,owner);let refreshCalls=0;
 try{await mocked(graph,()=>callback(f,start));
 f.sqlite.exec('UPDATE channels SET expires_at=1');
 const channel=f.sqlite.prepare('SELECT * FROM channels').get();
 const {publishZaloArticle}=await import('../src/channels.js');
 await mocked(async(url,init)=>{
  if(String(url).includes('access_token')){refreshCalls++;await new Promise(r=>setTimeout(r,20));return Response.json({access_token:'rotated-access',refresh_token:'rotated-refresh',expires_in:90000});}
  assert.equal(init.headers.access_token,'rotated-access');
  return String(url).endsWith('/create')?Response.json({error:0,data:{token:'article'}}):Response.json({error:0,data:{id:'post'}});
 },async()=>{
  const result=await Promise.allSettled([publishZaloArticle(f.env,f.env.DB,channel,{content:'One',images:['https://example.com/cover.png']}),publishZaloArticle(f.env,f.env.DB,channel,{content:'Two',images:['https://example.com/cover.png']})]);
  assert.equal(refreshCalls,1);assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  const updated=f.sqlite.prepare('SELECT * FROM channels').get();assert.notEqual(updated.refresh_token,'rotated-refresh');
  assert.equal((await publishZaloArticle(f.env,f.env.DB,updated,{content:'Next',images:['https://example.com/cover.png']})).ok,true);assert.equal(refreshCalls,1);
 });}finally{f.sqlite.close();}
});
test('channel diagnostics expose only configuration presence and exact callback, never tokens',async()=>{
 const f=fixture(),owner=f.login('email:owner@example.com');
 try{const r=await f.req(owner,'/channels'),j=await r.json();assert.equal(j.setup.zalo.configured,true);assert.equal(j.setup.zalo.callbackUri,base+'/auth/zalo/callback');assert.equal(JSON.stringify(j).includes('fixture-app-secret'),false);
 delete f.env.ZALO_APP_SECRET;assert.equal((await (await f.req(owner,'/channels')).json()).setup.zalo.configured,false);
 }finally{f.sqlite.close();}
});
test('failed token rotation stops publishing and requires reconnect without retrying a used refresh token',async()=>{
 const f=fixture(),owner=f.login('email:owner@example.com'),start=await begin(f,owner);
 try{await mocked(graph,()=>callback(f,start));f.sqlite.exec('UPDATE channels SET expires_at=1');
 const {publishZaloArticle}=await import('../src/channels.js');let requests=0;
 await mocked(async()=>{requests++;throw Error('response lost');},async()=>{
  await assert.rejects(publishZaloArticle(f.env,f.env.DB,f.sqlite.prepare('SELECT * FROM channels').get(),{content:'Test',images:['https://example.com/cover.png']}),/kết nối lại/);
  const row=f.sqlite.prepare('SELECT * FROM channels').get();assert.equal(row.status,'reauth_required');assert.equal(row.refresh_token,null);
  await assert.rejects(publishZaloArticle(f.env,f.env.DB,row,{content:'Test',images:['https://example.com/cover.png']}),/kết nối lại/);assert.equal(requests,1);
 });}finally{f.sqlite.close();}
});
test('legacy plaintext tokens are encrypted before use and cannot be moved to another shop',async()=>{
 const f=fixture(),owner=f.login('email:owner@example.com'),start=await begin(f,owner);
 try{await mocked(graph,()=>callback(f,start));
 f.sqlite.prepare('UPDATE channels SET token=?,refresh_token=?').run(access,refresh);
 const {publishZaloArticle}=await import('../src/channels.js');
 await mocked(async(url,init)=>{assert.equal(init.headers.access_token,access);if(String(url).endsWith('/getoa'))return Response.json({error:0,data:{oa_id:'123456789'}});return String(url).endsWith('/create')?Response.json({error:0,data:{token:'article'}}):Response.json({error:0,data:{id:'post'}});},async()=>{
  assert.equal((await publishZaloArticle(f.env,f.env.DB,f.sqlite.prepare('SELECT * FROM channels').get(),{content:'Test',images:['https://example.com/cover.png']})).ok,true);
  const stored=f.sqlite.prepare('SELECT * FROM channels').get();assert.ok(stored.token.startsWith('enc1.'));assert.ok(stored.refresh_token.startsWith('enc1.'));
  await assert.rejects(publishZaloArticle(f.env,f.env.DB,{...stored,shop_id:'other-shop'},{content:'Test',images:['https://example.com/cover.png']}));
 });}finally{f.sqlite.close();}
});
test('provider network errors return safe reconnection feedback instead of crashing callback',async()=>{
 const f=fixture(),owner=f.login('email:owner@example.com'),start=await begin(f,owner);
 try{await mocked(()=>{throw Error('secret provider error');},async()=>{
  const r=await callback(f,start);assert.equal(r.status,302);assert.match(r.headers.get('Location'),/temporary_error/);assert.equal(r.headers.get('Location').includes('secret'),false);
 });}finally{f.sqlite.close();}
});
test('Zalo articles follow the official v2 API, serve public cover media and require a verified article ID',async()=>{
 const f=fixture(),owner=f.login('email:owner@example.com'),start=await begin(f,owner);
 const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
 try{await mocked(graph,()=>callback(f,start));
 const {publishZaloArticle}=await import('../src/channels.js');let mediaUrl='';
 await mocked(async(url,init)=>{
  assert.equal(new URL(url).pathname.startsWith('/v2.0/article/'),true);
  if(String(url).endsWith('/create')){const payload=JSON.parse(init.body);mediaUrl=payload.cover.photo_url;assert.equal(payload.cover.status,'show');return Response.json({error:0,data:{token:'article'}});}
  return Response.json({error:0,data:{}});
 },async()=>{
  await assert.rejects(publishZaloArticle({...f.env,PUBLIC_ORIGIN:base},f.env.DB,f.sqlite.prepare('SELECT * FROM channels').get(),{content:'Test',images:[png]}),/xác nhận|mã bài/);
  const r=await worker.fetch(new Request(mediaUrl),f.env);assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'image/png');assert.ok((await r.arrayBuffer()).byteLength>0);
  assert.equal((await worker.fetch(new Request(base+'/media/zalo/not-a-valid-id'),f.env)).status,404);
 });}finally{f.sqlite.close();}
});
test('Zalo articles without required cover fail locally before contacting Zalo',async()=>{
 const {publishZaloArticle}=await import('../src/channels.js');
 await mocked(()=>{throw Error('must not send');},async()=>{
  await assert.rejects(publishZaloArticle({}, {}, {}, {content:'Test',images:[]}),/ảnh bìa/);
 });
});
test('reconnecting an OA supersedes an in-flight refresh without overwriting tokens',async()=>{
 const f=fixture(),owner=f.login('email:owner@example.com');
 await mocked(graph,()=>begin(f,owner).then(s=>callback(f,s)));
 f.sqlite.exec('UPDATE channels SET expires_at=1');
 const old=f.sqlite.prepare('SELECT * FROM channels').get();
 const start=await begin(f,owner);
 const {publishZaloArticle}=await import('../src/channels.js');
 let unblock, entered;
 const pending=new Promise(r=>{entered=r;});
 let publishToken;
 await mocked(async(url,init)=>{
  if(String(url).includes('access_token')){
   if(new URLSearchParams(init.body).get('grant_type')==='refresh_token'){
    entered();await new Promise(r=>{unblock=r;});
    return Response.json({access_token:'OA1-rotated-access',refresh_token:'OA1-rotated-refresh',expires_in:90000});
   }
   return Response.json({access_token:'OA2-access',refresh_token:'OA2-refresh',expires_in:90000});
  }
  if(String(url).endsWith('/getoa'))return Response.json({error:0,data:{oa_id:'222222',name:'New OA'}});
  publishToken=init.headers.access_token;
  return String(url).endsWith('/create')?Response.json({error:0,data:{token:'article'}}):Response.json({error:0,data:{id:'post'}});
 },async()=>{
  const publishing=publishZaloArticle(f.env,f.env.DB,old,{content:'Test',images:['https://example.com/cover.png']});
  const rejected=assert.rejects(publishing,/thay đổi|kết nối lại/);
  await pending;
  assert.match((await callback(f,start)).headers.get('Location'),/connected=zalo/);
  const newTokens=f.sqlite.prepare('SELECT * FROM channels').get();
  unblock();await rejected;
  const row=f.sqlite.prepare('SELECT * FROM channels').get();
  assert.equal(row.external_id,'222222');
  await publishZaloArticle(f.env,f.env.DB,row,{content:'After reconnect',images:['https://example.com/cover.png']});
  assert.equal(row.token,newTokens.token);assert.equal(row.refresh_token,newTokens.refresh_token);assert.equal(publishToken,'OA2-access');
 });f.sqlite.close();
});
test('unverified legacy connections are not shown connected and cannot publish',async()=>{
 const f=fixture(),owner=f.login('email:owner@example.com'),start=await begin(f,owner);
 try{await mocked(graph,()=>callback(f,start));f.sqlite.prepare('UPDATE channels SET external_id=NULL,token=?,refresh_token=?').run(access,refresh);
 const j=await (await f.req(owner,'/channels')).json();assert.equal(j.channels[0].status,'reauth_required');assert.equal(j.channels[0].needsReconnect,true);
 const {publishZaloArticle}=await import('../src/channels.js');
 await mocked(()=>{throw Error('must not publish');},async()=>{await assert.rejects(publishZaloArticle(f.env,f.env.DB,f.sqlite.prepare('SELECT * FROM channels').get(),{content:'Test',images:['https://example.com/cover.png']}),/kết nối lại/);});
 }finally{f.sqlite.close();}
});

test('disconnect Zalo deletes only current shop channel, invalidates in-flight OAuth and audits',async()=>{
 const f=fixture(),owner=f.login('email:owner@example.com'),start=await begin(f,owner);
 try{await mocked(graph,()=>callback(f,start));const shop=f.sqlite.prepare('SELECT shop_id FROM channels').get().shop_id;
 const next=await begin(f,owner);
 const result=await f.req(owner,'/channels/zalo','DELETE');assert.equal(result.status,200);
 assert.equal(f.sqlite.prepare('SELECT count(*) n FROM channels WHERE shop_id=?').get(shop).n,0);
 assert.equal(f.sqlite.prepare("SELECT count(*) n FROM audit_log WHERE action='channels.disconnect' AND shop_id=?").get(shop).n,1);
 assert.equal(f.sqlite.prepare('SELECT count(*) n FROM channel_oauth_states WHERE shop_id=?').get(shop).n,0);
 await mocked(graph,async()=>assert.match((await callback(f,next)).headers.get('Location'),/connect_error/));
 }finally{f.sqlite.close();}
});
test('channel listing never selects token material',async()=>{
 const f=fixture(),owner=f.login('email:owner@example.com');const queries=[];const original=f.env.DB.prepare;
 f.env.DB.prepare=s=>{queries.push(s);return original(s);};
 try{assert.equal((await f.req(owner,'/channels')).status,200);
 const query=queries.find(s=>s.startsWith('SELECT provider, external_id'));
 assert.ok(query);assert.doesNotMatch(query,/access_token|refresh_token/);
 }finally{f.sqlite.close();}
});

test('Zalo publish persists one common job and honors 429 backoff without duplicate article creation',async()=>{
 const f=fixture(),owner=f.login('email:zalo-jobs@example.com');await mocked(graph,()=>begin(f,owner).then(s=>callback(f,s)));
 const post=()=>worker.fetch(new Request(base+'/channels/zalo/publish',{method:'POST',headers:{Cookie:owner,Origin:base,'Content-Type':'application/json','Idempotency-Key':'zalo-shared-backoff-123'},body:JSON.stringify({content:'Test',images:['https://example.com/cover.jpg']})}),f.env);
 let creates=0;
 try{await mocked(async url=>{creates++;return Response.json({error:-1,message:'rate limited'},{status:429});},async()=>{
  assert.equal((await post()).status,429);assert.equal(creates,1);
  const j=f.sqlite.prepare('SELECT * FROM publish_jobs').get();assert.equal(j.status,'retryable');assert.ok(j.next_attempt_at>now());
  assert.equal((await post()).status,429);assert.equal(creates,1);
 });}finally{f.sqlite.close();}
});
test('scheduled Zalo job must not silently target a different OA after reconnect',async()=>{
 const f=fixture(),owner=f.login('email:zalo-target@example.com');await mocked(graph,()=>begin(f,owner).then(s=>callback(f,s)));
 try{const r=await worker.fetch(new Request(base+'/channels/zalo/schedule',{method:'POST',headers:{Cookie:owner,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({content:'Scheduled',images:['https://example.com/cover.jpg'],runAt:now()+60})}),f.env);
 assert.equal(r.status,201);f.sqlite.exec("UPDATE channels SET external_id='999999';UPDATE publish_jobs SET next_attempt_at=0");
 const {runDueScheduledPosts}=await import('../src/channels.js');
 await mocked(()=>{throw Error('must not send to new OA');},()=>runDueScheduledPosts(f.env));
 const j=f.sqlite.prepare('SELECT status,error_code FROM publish_jobs').get();assert.equal(j.status,'failed');assert.equal(j.error_code,'account_changed');
 }finally{f.sqlite.close();}
});

test('legacy schedules are bound to their original OA before an OAuth replacement',async()=>{
 const f=fixture(),owner=f.login('email:legacy-target@example.com');await mocked(graph,()=>begin(f,owner).then(s=>callback(f,s)));
 try{const shop=f.sqlite.prepare('SELECT shop_id FROM channels').get().shop_id;
 f.sqlite.prepare("INSERT INTO scheduled_posts(id,shop_id,provider,content,images,run_at,status) VALUES('legacy-before-reconnect',?,'zalo','Old OA content',?,0,'scheduled')").run(shop,JSON.stringify(['https://example.com/cover.jpg']));
 const start=await begin(f,owner);
 await mocked(async url=>String(url).includes('access_token')?graph(url):Response.json({error:0,data:{oa_id:'999999',name:'New OA'}}),()=>callback(f,start));
 const {runDueScheduledPosts}=await import('../src/channels.js');
 await mocked(()=>{throw Error('Must not send legacy content to replacement OA');},()=>runDueScheduledPosts(f.env));
 const job=f.sqlite.prepare("SELECT status,error_code FROM publish_jobs WHERE id='legacy-before-reconnect'").get();assert.equal(job.status,'failed');assert.equal(job.error_code,'account_changed');
 }finally{f.sqlite.close();}
});

test('unified account disconnect for Zalo also removes credential and invalidates OAuth',async()=>{
 const f=fixture(),owner=f.login('email:unified-disconnect@example.com');await mocked(graph,()=>begin(f,owner).then(s=>callback(f,s)));
 try{const id=f.sqlite.prepare('SELECT id FROM channels').get().id;await begin(f,owner);
 assert.equal((await f.req(owner,'/channels/zalo/accounts/'+id,'DELETE')).status,200);
 assert.equal(f.sqlite.prepare('SELECT count(*) n FROM channels').get().n,0);
 assert.equal(f.sqlite.prepare('SELECT count(*) n FROM channel_oauth_states').get().n,0);
 }finally{f.sqlite.close();}
});

test('disconnect invalidates a callback already awaiting token exchange',async()=>{
 const f=fixture(),owner=f.login('email:disconnect-inflight@example.com');await mocked(graph,()=>begin(f,owner).then(s=>callback(f,s)));
 const next=await begin(f,owner);let release,entered;const waiting=new Promise(r=>entered=r);
 try{await mocked(async url=>{if(String(url).includes('access_token')){entered();await new Promise(r=>release=r);}return graph(url);},async()=>{
 const pending=callback(f,next);await waiting;
 assert.equal((await f.req(owner,'/channels/zalo','DELETE')).status,200);release();
 assert.match((await pending).headers.get('Location'),/connect_error/);
 assert.equal(f.sqlite.prepare('SELECT count(*) n FROM channels').get().n,0);
 });}finally{f.sqlite.close();}
});

test('explicit retry after reauthorizing the same OA recovers a pre-send failure using the same job',async()=>{
 const f=fixture(),owner=f.login('email:safe-recovery@example.com');await mocked(graph,()=>begin(f,owner).then(s=>callback(f,s)));
 try{f.sqlite.exec('UPDATE channels SET expires_at=1,refresh_token=NULL');
 const r=await worker.fetch(new Request(base+'/channels/zalo/publish',{method:'POST',headers:{Cookie:owner,Origin:base,'Content-Type':'application/json','Idempotency-Key':'recover-same-oa-job-123'},body:JSON.stringify({content:'Recover',images:['https://example.com/cover.jpg']})}),f.env);
 const first=await r.json();assert.equal(first.job.status,'failed');assert.equal(first.job.errorCode,'provider_denied');
 await mocked(graph,()=>begin(f,owner).then(s=>callback(f,s)));
 let creates=0;await mocked(async url=>{if(String(url).endsWith('/create')){creates++;return Response.json({error:0,data:{token:'article'}});}return Response.json({error:0,data:{id:'post'}});},async()=>{
  const path='/channels/zalo/jobs/'+first.job.id+'/run';
  const resumed=await f.req(owner,path,'POST');assert.equal(resumed.status,200);assert.equal((await resumed.json()).job.id,first.job.id);
  assert.equal((await f.req(owner,path,'POST')).status,200);assert.equal(creates,1);
 });
 }finally{f.sqlite.close();}
});
