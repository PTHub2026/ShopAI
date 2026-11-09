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
  const row=f.sqlite.prepare('SELECT * FROM shop_channels').get();
  assert.notEqual(row.access_token,access);assert.notEqual(row.refresh_token,refresh);
  const second=await callback(f,start);assert.match(second.headers.get('Location'),/connect_error=/);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM auth_sessions').get().n,count);
 });}finally{f.sqlite.close();}
});
test('Zalo never connects when OA information cannot be verified',async()=>{
 const f=fixture(),owner=f.login('email:owner@example.com'),start=await begin(f,owner);
 try{await mocked(async url=>String(url).includes('access_token')?graph(url):Response.json({error:-201,message:'denied'},{status:403}),async()=>{
  const r=await callback(f,start);assert.match(r.headers.get('Location'),/connect_error=/);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM shop_channels').get().n,0);
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
 f.sqlite.exec('UPDATE shop_channels SET expires_at=1');
 const channel=f.sqlite.prepare('SELECT * FROM shop_channels').get();
 const {publishZaloArticle}=await import('../src/channels.js');
 await mocked(async(url,init)=>{
  if(String(url).includes('access_token')){refreshCalls++;await new Promise(r=>setTimeout(r,20));return Response.json({access_token:'rotated-access',refresh_token:'rotated-refresh',expires_in:90000});}
  assert.equal(init.headers.access_token,'rotated-access');
  return String(url).endsWith('/create')?Response.json({error:0,data:{token:'article'}}):Response.json({error:0,data:{id:'post'}});
 },async()=>{
  const result=await Promise.allSettled([publishZaloArticle(f.env,f.env.DB,channel,{content:'One',images:['https://example.com/cover.png']}),publishZaloArticle(f.env,f.env.DB,channel,{content:'Two',images:['https://example.com/cover.png']})]);
  assert.equal(refreshCalls,1);assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  const updated=f.sqlite.prepare('SELECT * FROM shop_channels').get();assert.notEqual(updated.refresh_token,'rotated-refresh');
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
 try{await mocked(graph,()=>callback(f,start));f.sqlite.exec('UPDATE shop_channels SET expires_at=1');
 const {publishZaloArticle}=await import('../src/channels.js');let requests=0;
 await mocked(async()=>{requests++;throw Error('response lost');},async()=>{
  await assert.rejects(publishZaloArticle(f.env,f.env.DB,f.sqlite.prepare('SELECT * FROM shop_channels').get(),{content:'Test',images:['https://example.com/cover.png']}),/kết nối lại/);
  const row=f.sqlite.prepare('SELECT * FROM shop_channels').get();assert.equal(row.status,'reauth_required');assert.equal(row.refresh_token,null);
  await assert.rejects(publishZaloArticle(f.env,f.env.DB,row,{content:'Test',images:['https://example.com/cover.png']}),/kết nối lại/);assert.equal(requests,1);
 });}finally{f.sqlite.close();}
});
test('legacy plaintext tokens are encrypted before use and cannot be moved to another shop',async()=>{
 const f=fixture(),owner=f.login('email:owner@example.com'),start=await begin(f,owner);
 try{await mocked(graph,()=>callback(f,start));
 f.sqlite.prepare('UPDATE shop_channels SET access_token=?,refresh_token=?').run(access,refresh);
 const {publishZaloArticle}=await import('../src/channels.js');
 await mocked(async(url,init)=>{assert.equal(init.headers.access_token,access);return String(url).endsWith('/create')?Response.json({error:0,data:{token:'article'}}):Response.json({error:0,data:{id:'post'}});},async()=>{
  assert.equal((await publishZaloArticle(f.env,f.env.DB,f.sqlite.prepare('SELECT * FROM shop_channels').get(),{content:'Test',images:['https://example.com/cover.png']})).ok,true);
  const stored=f.sqlite.prepare('SELECT * FROM shop_channels').get();assert.ok(stored.access_token.startsWith('enc1.'));assert.ok(stored.refresh_token.startsWith('enc1.'));
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
  await assert.rejects(publishZaloArticle({...f.env,PUBLIC_ORIGIN:base},f.env.DB,f.sqlite.prepare('SELECT * FROM shop_channels').get(),{content:'Test',images:[png]}),/xác nhận|mã bài/);
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
