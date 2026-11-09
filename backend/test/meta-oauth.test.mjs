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
 const env={DB,AI:{},AI_RATE_LIMITER:{},ACCESS_TEAM_DOMAIN:'test-team.cloudflareaccess.com',ACCESS_AUD:'test',SOCIAL_TOKEN_KEY:Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64'),META_APP_ID:'1234567890',META_APP_SECRET:'not-a-real-secret',META_REDIRECT_URI:base+'/api/social/meta/callback',META_GRAPH_VERSION:'v26.0'};
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
test('Meta OAuth: one-use state, same actor, scoped accounts, encrypted Page token',async()=>{
 const f=fixture(),owner=f.login('email:owner@example.com'),other=f.login('email:other@example.com');
 const start=await f.req(owner,'/api/social/meta/start','POST');
 assert.equal(start.status,200);
 const {authorizationUrl}=await start.json();
 const url=new URL(authorizationUrl);
 assert.equal(url.hostname,'www.facebook.com');
 assert.equal(url.searchParams.get('scope').includes('instagram_content_publish'),true);
 const state=url.searchParams.get('state');
 assert.match(state,/^[A-Za-z0-9_-]{43}$/);
 const tokenBefore=f.sqlite.prepare('SELECT state_hash FROM meta_oauth_states').get();
 assert.notEqual(tokenBefore.state_hash,state);
 const cb='/api/social/meta/callback?state='+encodeURIComponent(state)+'&code=FAKE_CODE_FOR_TEST';
 assert.equal((await f.req(other,cb)).status,403,'other actor cannot redeem callback');
 const previous=globalThis.fetch;
 let calls=[];
 globalThis.fetch=async(input,options)=>{
  const u=new URL(String(input));calls.push(u.pathname);
  assert.equal(u.hostname,'graph.facebook.com');
  if(u.pathname.endsWith('/oauth/access_token')){
   if(u.searchParams.has('code'))return Response.json({access_token:'short-lived'});
   if(u.searchParams.get('grant_type')==='fb_exchange_token')return Response.json({access_token:'long-lived'});
  }
  if(u.pathname.endsWith('/me/permissions')){
   assert.equal(options.headers.Authorization,'Bearer long-lived');
   return Response.json({data:['pages_show_list','pages_manage_posts','instagram_basic','instagram_content_publish'].map(permission=>({permission,status:'granted'}))});
  }
  if(u.pathname.endsWith('/me/accounts')){
   assert.equal(options.headers.Authorization,'Bearer long-lived');
   assert.equal(u.searchParams.has('access_token'),false);
   if(u.searchParams.has('after')){
    assert.equal(u.searchParams.get('after'),'page_two');
    return Response.json({data:[{id:'333333',name:'Other Page',access_token:'PAGE_SECRET_2'}]});
   }
   return Response.json({data:[{id:'111111',name:'Test Facebook Page',access_token:'PAGE_SECRET_DO_NOT_EXPOSE',instagram_business_account:{id:'222222',username:'shop_ig'}}],paging:{next:'https://graph.facebook.com/v26.0/me/accounts?after=page_two',cursors:{after:'page_two'}}});
  }
  throw Error('Unexpected Graph call');
 };
 try{
  const result=await f.req(owner,cb);
  assert.equal(result.status,303);assert.ok(result.headers.get('location').includes('meta_connected=3'));
  const listed=await f.req(owner,'/api/social/accounts');assert.equal(listed.status,200);
  const accounts=(await listed.json()).accounts;
  assert.deepEqual(accounts.map(x=>x.provider).sort(),['facebook','facebook','instagram']);
  assert.equal(JSON.stringify(accounts).includes('PAGE_SECRET'),false);
  const row=f.sqlite.prepare("SELECT token, token_iv FROM channels WHERE provider='facebook'").get();
  assert.notEqual(row.token,'PAGE_SECRET_DO_NOT_EXPOSE');assert.ok(row.token_iv.length>10);
  assert.equal((await f.req(owner,cb)).status,403,'callback replay rejected');
  assert.deepEqual(calls.map(p=>p.split('/').at(-1)),['access_token','access_token','permissions','accounts','accounts']);
 }finally{globalThis.fetch=previous;f.sqlite.close();}
});

test('OAuth start prunes expired states and preserves live states',async()=>{
 const f=fixture(),cookie=f.login('email:cleanup@example.com');
 try{
  await f.req(cookie,'/api/social/meta/start','POST');
  f.sqlite.prepare('INSERT INTO meta_oauth_states VALUES(?,?,?,?,?)').run('expired','shop','actor',now()-1,now()-601);
  f.sqlite.prepare('INSERT INTO meta_oauth_states VALUES(?,?,?,?,?)').run('boundary','shop','actor',now(),now()-600);
  await f.req(cookie,'/api/social/meta/start','POST');
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM meta_oauth_states WHERE expires_at<=?').get(now()).n,0);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM meta_oauth_states').get().n,2);
 }finally{f.sqlite.close();}
});
