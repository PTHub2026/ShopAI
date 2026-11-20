import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { facebook, openToken } from '../src/facebook.js';

function setup() {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0002_facebook.sql',import.meta.url),'utf8'));
  const DB={
    prepare(sql){
      const statement=sqlite.prepare(sql);
      return {bind(...params){return {
        async first(){return statement.get(...params)||null},
        async all(){return {results:statement.all(...params)}},
        async run(){return {meta:{changes:Number(statement.run(...params).changes)}}},
        _run(){return {meta:{changes:Number(statement.run(...params).changes)}}}
      }}};
    },
    async batch(statements){
      sqlite.exec('BEGIN');
      try {const rows=statements.map(s=>s._run());sqlite.exec('COMMIT');return rows}
      catch(e){sqlite.exec('ROLLBACK');throw e}
    }
  };
  const env={DB,FACEBOOK_OAUTH_ENABLED:'true',FACEBOOK_APP_ID:'1690219679401963',FACEBOOK_APP_SECRET:'fixture-secret',CHANNEL_TOKEN_KEY:btoa('k'.repeat(32)),APP_ORIGIN:'https://app.example',AI_RATE_LIMITER:{limit:async()=>({success:true})}};
  const call=(path='',{owner='alice',method='GET',origin='https://app.example'}={})=>facebook(new Request('https://app.example/channels/facebook'+path,{method,headers:{Origin:origin}}),env,owner,(v,s=200,h={})=>Response.json(v,{status:s,headers:h}));
  return {sqlite,env,call};
}
async function start(s,owner='alice'){const r=await s.call('/start',{method:'POST',owner});assert.equal(r.status,200);return new URL((await r.json()).url)}
function graph(t,override={}) {
  const calls=[];
  t.mock.method(globalThis,'fetch',async (url,init)=>{
    const u=new URL(url);calls.push({u,init});assert.equal(u.origin,'https://graph.facebook.com');assert.equal(init.redirect,'manual');
    if(u.pathname.endsWith('/oauth/access_token'))return Response.json({access_token:'USER-TOKEN',expires_in:3600});
    if(u.pathname.endsWith('/debug_token'))return Response.json({data:{is_valid:true,app_id:'1690219679401963',user_id:'42',expires_at:Math.floor(Date.now()/1000)+3600,...override}});
    if(u.pathname.endsWith('/me/permissions'))return Response.json({data:['pages_show_list','pages_read_engagement','pages_manage_posts','pages_manage_metadata','pages_messaging'].map(permission=>({permission,status:'granted'}))});
    if(u.pathname.endsWith('/me/accounts'))return Response.json({data:[{id:'123',name:'Trang <script> thật',access_token:'PAGE-SECRET',tasks:['CREATE_CONTENT','MESSAGING']} ]});
    throw Error('Unexpected request');
  });return calls;
}
test('Facebook disabled or incomplete configuration never starts OAuth',async()=>{
  const s=setup();try{delete s.env.FACEBOOK_APP_SECRET;assert.equal((await s.call('/start',{method:'POST'})).status,503);assert.equal((await (await s.call()).json()).configured,false);s.env.FACEBOOK_APP_SECRET='fixture';s.env.CHANNEL_TOKEN_KEY='broken';assert.equal((await s.call('/start',{method:'POST'})).status,503)}finally{s.sqlite.close()}
});
test('OAuth start enforces origin and stores only expiring owner-bound state hash',async()=>{
 const s=setup();try{assert.equal((await s.call('/start',{method:'POST',origin:'https://evil.example'})).status,403);assert.equal((await s.call('/start')).status,405);const u=await start(s);assert.equal(u.origin,'https://www.facebook.com');assert.equal(u.searchParams.get('redirect_uri'),'https://app.example/channels/facebook/callback');assert.ok(u.searchParams.get('state').length>=43);const row=s.sqlite.prepare('SELECT * FROM oauth_states').get();assert.equal(row.owner,'alice');assert.notEqual(row.state_hash,u.searchParams.get('state'));assert.ok(row.expires_at>Date.now());assert.ok(row.expires_at<=Date.now()+600000);assert.ok(!u.href.includes('fixture-secret'))}finally{s.sqlite.close()}
});
test('OAuth state rejects wrong owner, expired and replayed callbacks before network',async(t)=>{
 const s=setup();let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error()});try{const u=await start(s);const p='/callback?state='+u.searchParams.get('state')+'&code=code';assert.equal((await s.call(p,{owner:'bob'})).status,400);s.sqlite.exec('UPDATE oauth_states SET expires_at=0');assert.equal((await s.call(p)).status,400);assert.equal(calls,0)}finally{s.sqlite.close()}
});
test('Verified Page tokens are encrypted, scoped and never returned; callback is one-time',async(t)=>{
 const s=setup();const calls=graph(t);try{const u=await start(s);const p='/callback?state='+u.searchParams.get('state')+'&code=code';const r=await s.call(p);assert.equal(r.status,303);assert.equal(r.headers.get('Location'),'https://app.example/?facebook=connected#accounts');const row=s.sqlite.prepare('SELECT * FROM facebook_connections').get();assert.ok(!JSON.stringify(row).includes('PAGE-SECRET'));assert.equal(await openToken(row.token_cipher,s.env.CHANNEL_TOKEN_KEY,'alice','123'),'PAGE-SECRET');await assert.rejects(openToken(row.token_cipher,s.env.CHANNEL_TOKEN_KEY,'bob','123'));const data=await (await s.call()).json();assert.equal(data.channels[0].pageId,'123');assert.ok(!JSON.stringify(data).includes('token'));assert.deepEqual((await (await s.call('',{owner:'bob'})).json()).channels,[]);const n=calls.length;assert.equal((await s.call(p)).status,400);assert.equal(calls.length,n);assert.equal((await s.call('/123/disconnect',{method:'POST',owner:'bob'})).status,404);assert.equal((await s.call('/123/disconnect',{method:'POST'})).status,200);assert.equal(s.sqlite.prepare('SELECT token_cipher FROM facebook_connections').get().token_cipher,null)}finally{s.sqlite.close()}
});
test('Wrong app cannot create a connection',async(t)=>{
 const s=setup();graph(t,{app_id:'999'});try{const u=await start(s);assert.equal((await s.call('/callback?state='+u.searchParams.get('state')+'&code=code')).status,502);assert.equal(s.sqlite.prepare('SELECT COUNT(*) n FROM facebook_connections').get().n,0)}finally{s.sqlite.close()}
});
test('Cancelled OAuth consumes state without exchanging tokens',async(t)=>{
 const s=setup();let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error()});try{const u=await start(s);const state=u.searchParams.get('state');assert.equal((await s.call('/callback?state='+state+'&error=access_denied')).status,303);assert.equal((await s.call('/callback?state='+state+'&code=code')).status,400);assert.equal(calls,0)}finally{s.sqlite.close()}
});

test('Denied Page-list permission preserves existing connections and hides provider details',async(t)=>{
 const s=setup();graph(t);try{
  let u=await start(s);await s.call('/callback?state='+u.searchParams.get('state')+'&code=first');
  const original=fetch;
  t.mock.method(globalThis,'fetch',async(url,init)=>String(url).includes('/me/permissions')?Response.json({data:[{permission:'pages_show_list',status:'declined'}]}):original(url,init));
  u=await start(s);const r=await s.call('/callback?state='+u.searchParams.get('state')+'&code=second');assert.equal(r.status,502);
  assert.equal(s.sqlite.prepare('SELECT status FROM facebook_connections').get().status,'connected');assert.ok(!(await r.text()).includes('USER-TOKEN'));
 }finally{s.sqlite.close()}
});
test('Pagination uses a fixed Graph origin and collects all authorized Pages',async(t)=>{
 const s=setup();graph(t);const original=fetch;let pages=0;
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  const u=new URL(url);assert.equal(u.origin,'https://graph.facebook.com');
  if(u.pathname.endsWith('/me/accounts')){pages++;return pages===1?Response.json({data:[{id:'123',name:'Page one',access_token:'PAGE-ONE-TOKEN',tasks:[]}],paging:{next:'https://evil.example/steal-token',cursors:{after:'cursor'}}}):Response.json({data:[{id:'456',name:'Page two',access_token:'PAGE-TWO-TOKEN',tasks:[]}]})}
  return original(url,init);
 });
 try{const u=await start(s);assert.equal((await s.call('/callback?state='+u.searchParams.get('state')+'&code=code')).status,303);assert.equal((await (await s.call()).json()).channels.length,2);assert.equal(pages,2)}finally{s.sqlite.close()}
});
test('Expired provider token cannot connect',async(t)=>{
 const s=setup();graph(t,{expires_at:1});try{const u=await start(s);assert.equal((await s.call('/callback?state='+u.searchParams.get('state')+'&code=code')).status,502);assert.equal(s.sqlite.prepare('SELECT COUNT(*) n FROM facebook_connections').get().n,0)}finally{s.sqlite.close()}
});

test('Inventory OAuth requests only Page-list permission; config-ID scope must be explicitly verified',async()=>{
 const s=setup();try{const u=await start(s);assert.equal(u.searchParams.get('scope'),'pages_show_list');assert.deepEqual((await (await s.call()).json()).permissions,['pages_show_list']);s.env.FACEBOOK_CONFIG_ID='999999';assert.equal((await s.call('/start',{method:'POST'})).status,503);s.env.FACEBOOK_CONFIG_SCOPES='pages_show_list';const config=await start(s);assert.equal(config.searchParams.get('config_id'),'999999');assert.equal(config.searchParams.has('scope'),false);s.env.FACEBOOK_CONFIG_SCOPES='pages_show_list,pages_manage_posts';assert.equal((await s.call('/start',{method:'POST'})).status,503)}finally{s.sqlite.close()}
});

test('Disconnect while OAuth is in flight cannot be undone by the late callback',async(t)=>{
 const s=setup();graph(t);try{
  let u=await start(s);assert.equal((await s.call('/callback?state='+u.searchParams.get('state')+'&code=first')).status,303);
  let release,entered;const pending=new Promise(r=>release=r),reached=new Promise(r=>entered=r);const original=fetch;
  t.mock.method(globalThis,'fetch',async(url,init)=>{if(String(url).includes('/me/accounts')){entered();await pending}return original(url,init)});
  u=await start(s);const callback=s.call('/callback?state='+u.searchParams.get('state')+'&code=second');await reached;
  assert.equal((await s.call('/123/disconnect',{method:'POST'})).status,200);release();
  assert.equal((await callback).status,409);const row=s.sqlite.prepare('SELECT status,token_cipher FROM facebook_connections').get();assert.equal(row.status,'disconnected');assert.equal(row.token_cipher,null);
 }finally{s.sqlite.close()}
});
