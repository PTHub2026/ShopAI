import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {webcrypto,createHash} from 'node:crypto';
import worker from '../src/worker.js';
import {SESSION_COOKIE} from '../src/auth.js';
import {syncInstagramFromPages} from '../src/meta.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const base='https://shoppost.example';
const now=()=>Math.floor(Date.now()/1000);
const APP_ID='1234567890',APP_SECRET='app-secret-for-test';
function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 for(const file of ['0001_drafts.sql','0002_auth.sql'])sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const stmt=(sql,p=[])=>({bind:(...a)=>stmt(sql,a),async first(){return sqlite.prepare(sql).get(...p)||null;},async all(){return {results:sqlite.prepare(sql).all(...p)};},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...p).changes)}};},exec(){return {meta:{changes:Number(sqlite.prepare(sql).run(...p).changes)}};}});
 const DB={sqlite,prepare:s=>stmt(s),async batch(stmts){sqlite.exec('BEGIN');try{const v=stmts.map(x=>x.exec());sqlite.exec('COMMIT');return v;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const env={DB,AI:{},AI_RATE_LIMITER:{},ACCESS_TEAM_DOMAIN:'test-team.cloudflareaccess.com',ACCESS_AUD:'test',SOCIAL_TOKEN_KEY:Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),META_APP_ID:APP_ID,META_APP_SECRET:APP_SECRET,META_REDIRECT_URI:base+'/api/social/meta/callback',META_GRAPH_VERSION:'v26.0'};
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
async function withGraph(handler,fn){
 const previous=globalThis.fetch;const calls=[];
 globalThis.fetch=async(input,options={})=>{
  const u=new URL(String(input));calls.push({path:u.pathname,method:options.method||'GET'});
  assert.equal(u.hostname,'graph.facebook.com');
  assert.equal(u.searchParams.has('access_token'),false,'token không được nằm trong URL');
  assert.equal(u.searchParams.has('input_token'),false,'token không được nằm trong URL');
  return handler(u,options);
 };
 try{return await fn(calls);}finally{globalThis.fetch=previous;}
}
// Kết nối một Trang Facebook chưa liên kết Instagram qua luồng OAuth thật của hệ thống.
async function connectPage(f,owner){
 const start=await f.req(owner,'/api/social/meta/start','POST');
 const state=new URL((await start.json()).authorizationUrl).searchParams.get('state');
 await withGraph(u=>{
  if(u.pathname.endsWith('/oauth/access_token'))return Response.json({access_token:u.searchParams.has('code')?'short':'long-lived'});
  if(u.pathname.endsWith('/me/permissions'))return Response.json({data:['pages_show_list','pages_manage_posts'].map(permission=>({permission,status:'granted'}))});
  if(u.pathname.endsWith('/me/accounts'))return Response.json({data:[{id:'111111',name:'Trang Thử',access_token:'PAGE_TOKEN_SECRET'}]});
  throw Error('Unexpected Graph call '+u.pathname);
 },async()=>{
  const r=await f.req(owner,'/api/social/meta/callback?state='+encodeURIComponent(state)+'&code=FAKE');
  assert.equal(r.status,303);assert.ok(r.headers.get('location').includes('meta_connected=1'));
 });
}
function graphWith({ig=null,scopes=[]}){
 return async(u,options)=>{
  if(u.pathname==='/v26.0/111111'){
   assert.equal(options.headers.Authorization,'Bearer PAGE_TOKEN_SECRET');
   assert.equal(u.searchParams.get('fields'),'instagram_business_account{id,username}');
   return Response.json(ig?{id:'111111',instagram_business_account:ig}:{id:'111111'});
  }
  if(u.pathname==='/v26.0/debug_token'){
   assert.equal(options.method,'POST');
   assert.equal(options.headers.Authorization,'Bearer '+APP_ID+'|'+APP_SECRET);
   const body=new URLSearchParams(options.body);
   assert.equal(body.get('input_token'),'PAGE_TOKEN_SECRET');assert.equal(body.get('method'),'GET');
   return Response.json({data:{is_valid:true,app_id:APP_ID,type:'PAGE',scopes}});
  }
  throw Error('Unexpected Graph call '+u.pathname);
 };
}
const providers=async(f,owner)=>(await (await f.req(owner,'/api/social/accounts')).json()).accounts.map(a=>a.provider+':'+a.status).sort();

test('Đồng bộ Instagram: Trang chưa liên kết thì không thêm kênh và không gọi debug_token',async()=>{
 const f=fixture(),owner=f.login('email:owner@example.com');
 try{
  await connectPage(f,owner);
  await withGraph(graphWith({}),async calls=>{
   const r=await f.req(owner,'/channels/meta/sync','POST');
   assert.equal(r.status,200);
   const body=await r.json();
   assert.deepEqual({pages:body.pages,linked:body.linked,connected:body.connected,errors:body.errors},{pages:1,linked:0,connected:0,errors:0});
   assert.deepEqual(calls.map(c=>c.path.split('/').at(-1)),['111111']);
   assert.equal(JSON.stringify(body).includes('PAGE_TOKEN'),false);
  });
  assert.deepEqual(await providers(f,owner),['facebook:active']);
 }finally{f.sqlite.close();}
});

test('Đồng bộ Instagram: Trang đã liên kết nhưng thiếu quyền Instagram thì báo missingPermission',async()=>{
 const f=fixture(),owner=f.login('email:owner@example.com');
 try{
  await connectPage(f,owner);
  await withGraph(graphWith({ig:{id:'222222',username:'shop_ig'},scopes:['pages_show_list','pages_manage_posts','instagram_basic']}),async()=>{
   const body=await (await f.req(owner,'/api/social/meta/sync','POST')).json();
   assert.equal(body.linked,1);assert.equal(body.missingPermission,1);assert.equal(body.connected,0);
  });
  assert.deepEqual(await providers(f,owner),['facebook:active']);
 }finally{f.sqlite.close();}
});

test('Đồng bộ Instagram: đủ quyền thì thêm kênh mã hóa token, chạy lại không tạo trùng',async()=>{
 const f=fixture(),owner=f.login('email:owner@example.com');
 const scopes=['pages_show_list','pages_manage_posts','instagram_basic','instagram_content_publish'];
 try{
  await connectPage(f,owner);
  await withGraph(graphWith({ig:{id:'222222',username:'shop_ig'},scopes}),async calls=>{
   const first=await (await f.req(owner,'/channels/meta/sync','POST')).json();
   assert.equal(first.connected,1);
   const row=f.sqlite.prepare("SELECT name,token,token_iv,connected_by,status FROM channels WHERE provider='instagram'").get();
   assert.equal(row.name,'shop_ig');assert.equal(row.status,'connected');assert.equal(row.connected_by,'email:owner@example.com');
   assert.notEqual(row.token,'PAGE_TOKEN_SECRET');assert.ok(row.token_iv.length>10);
   const before=calls.length;
   const second=await (await f.req(owner,'/channels/meta/sync','POST')).json();
   assert.equal(second.connected,0);assert.equal(second.alreadyConnected,1);
   assert.deepEqual(calls.slice(before).map(c=>c.path.split('/').at(-1)),['111111'],'kênh đã có thì không gọi debug_token');
  });
  assert.deepEqual(await providers(f,owner),['facebook:active','instagram:active']);
  const audits=f.sqlite.prepare("SELECT count(*) n FROM audit_log WHERE action='social.connect' AND target='222222'").get();
  assert.equal(audits.n,1);
 }finally{f.sqlite.close();}
});

test('Đồng bộ Instagram: chạy nền không khôi phục kênh Chủ shop đã ngắt, bấm kiểm tra thì khôi phục',async()=>{
 const f=fixture(),owner=f.login('email:owner@example.com');
 const scopes=['instagram_basic','instagram_content_publish','pages_manage_posts'];
 try{
  await connectPage(f,owner);
  await withGraph(graphWith({ig:{id:'222222',username:'shop_ig'},scopes}),async()=>{
   assert.equal((await (await f.req(owner,'/api/social/meta/sync','POST')).json()).connected,1);
   f.sqlite.prepare("UPDATE channels SET status='revoked',token='',token_iv='' WHERE provider='instagram'").run();
   const auto=await syncInstagramFromPages(f.env,f.env.DB);
   assert.equal(auto.connected,0);
   assert.equal(f.sqlite.prepare("SELECT status FROM channels WHERE provider='instagram'").get().status,'revoked');
   const manual=await (await f.req(owner,'/api/social/meta/sync','POST')).json();
   assert.equal(manual.connected,1);
   assert.equal(f.sqlite.prepare("SELECT status FROM channels WHERE provider='instagram'").get().status,'connected');
  });
 }finally{f.sqlite.close();}
});

test('Đồng bộ Instagram: chỉ nhận POST, cron chỉ chạy ở 5 phút đầu mỗi giờ',async()=>{
 const f=fixture(),owner=f.login('email:owner@example.com');
 try{
  assert.equal((await f.req(owner,'/api/social/meta/sync','GET')).status,405);
  await connectPage(f,owner);
  await withGraph(graphWith({}),async calls=>{
   const run=async minute=>{const tasks=[];await worker.scheduled({cron:'*/5 * * * *',scheduledTime:Date.UTC(2026,10,10,11,minute)},f.env,{waitUntil:p=>tasks.push(p)});await Promise.all(tasks);};
   await run(17);
   assert.equal(calls.filter(c=>c.path==='/v26.0/111111').length,0);
   await run(0);
   assert.equal(calls.filter(c=>c.path==='/v26.0/111111').length,1);
  });
 }finally{f.sqlite.close();}
});

test('Đồng bộ Instagram: lỗi Graph được đếm, không làm hỏng kết quả và không lộ token',async()=>{
 const f=fixture(),owner=f.login('email:owner@example.com');
 const warn=console.warn;const logs=[];console.warn=m=>logs.push(String(m));
 try{
  await connectPage(f,owner);
  await withGraph(async()=>Response.json({error:{code:190,message:'expired PAGE_TOKEN_SECRET'}},{status:400}),async()=>{
   const body=await (await f.req(owner,'/api/social/meta/sync','POST')).json();
   assert.equal(body.errors,1);assert.equal(body.connected,0);
  });
  assert.ok(logs.some(l=>l.includes('meta_ig_sync_failed')));
  assert.equal(logs.join('\n').includes('PAGE_TOKEN_SECRET'),false);
 }finally{console.warn=warn;f.sqlite.close();}
});
