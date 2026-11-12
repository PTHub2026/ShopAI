import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {sqliteDB} from './sqlite-fixture.mjs';
import worker from '../src/worker.js';
import {SESSION_COOKIE} from '../src/auth.js';
const base='https://shoppost.example';
const scopes='https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload';
function fixture(){
 const DB=sqliteDB(),now=Math.floor(Date.now()/1000);
 const env={DB,AI:{},AI_RATE_LIMITER:{},ACCESS_TEAM_DOMAIN:'test.cloudflareaccess.com',ACCESS_AUD:'test',SOCIAL_TOKEN_KEY:Buffer.alloc(32,7).toString('base64'),GOOGLE_CLIENT_ID:'test.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'test-secret',GOOGLE_REDIRECT_URI:base+'/api/social/google/callback'};
 function login(owner){const t=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');DB.sqlite.prepare('INSERT INTO auth_sessions(token_hash,owner,provider,created_at,expires_at) VALUES(?,?,?,?,?)').run(createHash('sha256').update(t).digest('hex'),owner,'email',now,now+3600);return SESSION_COOKIE+'='+t;}
 const owner=login('email:owner@example.com'),other=login('email:other@example.com');
 async function req(path,method='GET',body,extra={},cookie=owner){return worker.fetch(new Request(base+'/api/social/google/'+path,{method,headers:{Cookie:cookie,Origin:base,...(body?{'Content-Type':'application/json'}:{}),...extra},...(body?{body:typeof body==='string'?body:JSON.stringify(body)}:{})}),env);}
 return {DB,env,owner,other,req};
}
async function authorize(f){const r=await f.req('start','POST',{});assert.equal(r.status,200);return new URL((await r.json()).authorizationUrl);}
function providerFetch(){return async(input,init)=>{
 const u=new URL(String(input));
 if(u.hostname==='oauth2.googleapis.com'){assert.equal(init.method,'POST');assert.equal(u.search,'');return Response.json({access_token:'ACCESS_PRIVATE',refresh_token:'REFRESH_PRIVATE',expires_in:3600,scope:scopes});}
 if(u.pathname==='/youtube/v3/channels'){assert.equal(init.headers.Authorization,'Bearer ACCESS_PRIVATE');return Response.json({items:[{id:'UCabcdefghijklmnopqrstuv',snippet:{title:'ShopTrack TV'}}]});}
 throw Error('Unexpected provider request '+u.origin+u.pathname);
};}
test('Google: absent configuration is disabled without breaking existing providers',async()=>{
 const f=fixture();delete f.env.GOOGLE_CLIENT_SECRET;
 assert.equal((await f.req('start','POST',{})).status,503);
 const r=await f.req('accounts');assert.equal(r.status,200);assert.equal((await r.json()).configured,false);f.DB.sqlite.close();
});
test('Google: one-use PKCE state, actor binding, verified channel and encrypted credentials',async()=>{
 const f=fixture(),url=await authorize(f),state=url.searchParams.get('state');
 assert.equal(url.hostname,'accounts.google.com');assert.equal(url.searchParams.get('access_type'),'offline');assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.ok(url.searchParams.get('code_challenge'));assert.equal(url.searchParams.get('scope'),scopes);
 const cb='callback?state='+state+'&code=test-code';
 assert.equal((await f.req(cb,'GET',undefined,{},f.other)).status,403);
 const prior=globalThis.fetch;globalThis.fetch=providerFetch();
 try{const r=await f.req(cb);assert.equal(r.status,303);assert.match(r.headers.get('location'),/google_connected=1/);
  const list=await f.req('accounts'),data=await list.json();assert.equal(data.accounts.length,1);assert.equal(data.accounts[0].name,'ShopTrack TV');assert.doesNotMatch(JSON.stringify(data),/PRIVATE/);
  const row=f.DB.sqlite.prepare('SELECT credential,credential_iv FROM google_channels').get();assert.doesNotMatch(row.credential,/PRIVATE/);assert.ok(row.credential_iv);
  assert.equal((await f.req(cb)).status,403);
 }finally{globalThis.fetch=prior;f.DB.sqlite.close();}
});
test('Google: missing scope or offline token never records a working connection',async()=>{
 const prior=globalThis.fetch;
 for(const incomplete of [{scope:scopes.split(' ')[0],refresh_token:'refresh'},{scope:scopes}]){
  const f=fixture(),url=await authorize(f);globalThis.fetch=async()=>Response.json({access_token:'PRIVATE',expires_in:3600,...incomplete});
  try{const r=await f.req('callback?state='+url.searchParams.get('state')+'&code=test');assert.equal(r.status,422);assert.equal((await (await f.req('accounts')).json()).accounts.length,0);}finally{f.DB.sqlite.close();}
 }globalThis.fetch=prior;
});
test('Google: disconnect cancels in-flight authorization in the same shop',async()=>{
 const f=fixture(),a=await authorize(f),b=await authorize(f),prior=globalThis.fetch;globalThis.fetch=providerFetch();
 try{assert.equal((await f.req('callback?state='+a.searchParams.get('state')+'&code=test')).status,303);
  const account=(await (await f.req('accounts')).json()).accounts[0];
  assert.equal((await f.req('accounts/'+account.id,'DELETE',undefined,{},f.other)).status,404);
  assert.equal((await f.req('accounts/'+account.id,'DELETE')).status,200);
  assert.equal((await f.req('callback?state='+b.searchParams.get('state')+'&code=test')).status,403);
  const row=f.DB.sqlite.prepare('SELECT credential,status FROM google_channels').get();assert.equal(row.credential,'');assert.equal(row.status,'revoked');
 }finally{globalThis.fetch=prior;f.DB.sqlite.close();}
});
test('YouTube: streaming upload confirms video ID and duplicate requests never upload twice',async()=>{
 const f=fixture(),url=await authorize(f),prior=globalThis.fetch;
 globalThis.fetch=providerFetch();
 try{
  await f.req('callback?state='+url.searchParams.get('state')+'&code=test');
  const a=(await (await f.req('accounts')).json()).accounts[0];let uploads=0;
  globalThis.fetch=async(input,init)=>{
   const u=new URL(String(input));
   if(u.pathname==='/youtube/v3/channels')return providerFetch()(input,init);
   if(u.pathname==='/upload/youtube/v3/videos'&&init.method==='POST'){
    assert.equal(init.headers.Authorization,'Bearer ACCESS_PRIVATE');
    assert.equal(JSON.parse(init.body).status.privacyStatus,'private');
    return new Response(null,{status:200,headers:{Location:'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=FAKE'}});
   }
   if(u.searchParams.has('upload_id')){uploads++;assert.ok(init.body instanceof ReadableStream);assert.equal(await new Response(init.body).text(),'video');return Response.json({id:'abcdefghijk'});}
   throw Error('Unexpected upload request');
  };
  const p='upload?accountId='+a.id+'&title=Test&privacy=private&madeForKids=false';
  const headers={'Content-Type':'video/mp4','Content-Length':'5','Idempotency-Key':'youtube-upload-test-1234'};
  const sent=await f.req(p,'POST','video',headers);assert.equal(sent.status,200);assert.equal((await sent.json()).videoId,'abcdefghijk');
  assert.equal((await f.req(p,'POST','video',headers)).status,200);assert.equal(uploads,1);
  assert.equal((await f.req(p.replace('title=Test','title=Other'),'POST','video',headers)).status,409);
  assert.equal((await (await f.req('uploads')).json()).uploads[0].status,'sent');
 }finally{globalThis.fetch=prior;f.DB.sqlite.close();}
});
test('YouTube: uncertain delivery is never retried and unsafe session URLs never receive tokens',async()=>{
 for(const mode of ['network','redirect']){
  const f=fixture(),url=await authorize(f),prior=globalThis.fetch;globalThis.fetch=providerFetch();
  try{
   await f.req('callback?state='+url.searchParams.get('state')+'&code=test');const a=(await (await f.req('accounts')).json()).accounts[0];let calls=0;
   globalThis.fetch=async(input,init)=>{if(new URL(String(input)).pathname==='/youtube/v3/channels')return providerFetch()(input,init);calls++;const u=new URL(String(input));assert.equal(u.hostname,'www.googleapis.com');if(!u.searchParams.has('upload_id'))return new Response(null,{status:200,headers:{Location:mode==='redirect'?'https://attacker.example/upload':'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=fake'}});throw Error('network lost');};
   const p='upload?accountId='+a.id+'&title=Test&privacy=private&madeForKids=false',h={'Content-Type':'video/mp4','Content-Length':'5','Idempotency-Key':'youtube-uncertain-1234'};
   assert.equal((await f.req(p,'POST','video',h)).status,502);
   const before=calls;assert.equal((await f.req(p,'POST','video',h)).status,409);assert.equal(calls,before);
   assert.equal((await (await f.req('uploads')).json()).uploads[0].status,mode==='network'?'unknown':'failed');
  }finally{globalThis.fetch=prior;f.DB.sqlite.close();}
 }
});
test('Google: a callback awaiting Google cannot reconnect after disconnect',async()=>{
 const f=fixture(),first=await authorize(f),prior=globalThis.fetch;globalThis.fetch=providerFetch();
 try{
  await f.req('callback?state='+first.searchParams.get('state')+'&code=test');
  const a=(await (await f.req('accounts')).json()).accounts[0],second=await authorize(f);
  let release,entered;const gate=new Promise(r=>release=r),waiting=new Promise(r=>entered=r);
  globalThis.fetch=async(input,init)=>{if(new URL(String(input)).hostname==='oauth2.googleapis.com'){entered();await gate;}return providerFetch()(input,init);};
  const callback=f.req('callback?state='+second.searchParams.get('state')+'&code=test');await waiting;
  assert.equal((await f.req('accounts/'+a.id,'DELETE')).status,200);release();assert.equal((await callback).status,403);
  assert.equal(f.DB.sqlite.prepare('SELECT credential FROM google_channels').get().credential,'');
 }finally{globalThis.fetch=prior;f.DB.sqlite.close();}
});
test('Google: stale provider data is removed after 30 days',async()=>{
 const f=fixture(),url=await authorize(f),prior=globalThis.fetch;globalThis.fetch=providerFetch();
 try{await f.req('callback?state='+url.searchParams.get('state')+'&code=test');f.DB.sqlite.prepare('UPDATE google_channels SET updated_at=?').run(Math.floor(Date.now()/1000)-31*86400);assert.equal((await (await f.req('accounts')).json()).accounts.length,0);}finally{globalThis.fetch=prior;f.DB.sqlite.close();}
});
test('YouTube: disconnect during session initialization prevents sending video bytes',async()=>{
 const f=fixture(),url=await authorize(f),prior=globalThis.fetch;globalThis.fetch=providerFetch();
 try{
  await f.req('callback?state='+url.searchParams.get('state')+'&code=test');const account=(await (await f.req('accounts')).json()).accounts[0];let sent=0;
  globalThis.fetch=async(input,init)=>{
   const u=new URL(String(input));if(u.pathname==='/youtube/v3/channels')return providerFetch()(input,init);
   if(init.method==='POST'){assert.equal((await f.req('accounts/'+account.id,'DELETE')).status,200);return new Response(null,{status:200,headers:{Location:'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=TEST'}});}
   sent++;return Response.json({id:'abcdefghijk'});
  };
  const r=await f.req('upload?accountId='+account.id+'&title=Test&privacy=private&madeForKids=false','POST','video',{'Content-Type':'video/mp4','Content-Length':'5','Idempotency-Key':'disconnect-upload-test'});
  assert.equal(r.status,502);assert.equal((await r.json()).status,'failed');assert.equal(sent,0);
 }finally{globalThis.fetch=prior;f.DB.sqlite.close();}
});

test('YouTube report reads channel videos and distinguishes zero from missing statistics',async()=>{
 const f=fixture(),url=await authorize(f),prior=globalThis.fetch,channel='UCabcdefghijklmnopqrstuv';
 globalThis.fetch=providerFetch();
 try{
  assert.equal((await f.req('callback?state='+url.searchParams.get('state')+'&code=test')).status,303);
  const account=(await (await f.req('accounts')).json()).accounts[0];
  const calls=[];
  globalThis.fetch=async(input,init)=>{
   const u=new URL(String(input));
   assert.equal(u.origin,'https://www.googleapis.com');
   assert.equal(init.headers.Authorization,'Bearer ACCESS_PRIVATE');
   calls.push(u.pathname);
   if(u.pathname.endsWith('/channels'))return Response.json({items:[{id:channel,contentDetails:{relatedPlaylists:{uploads:'UUuploads'}}}]});
   if(u.pathname.endsWith('/playlistItems')){
    assert.equal(u.searchParams.get('playlistId'),'UUuploads');
    return Response.json({items:['abcdefghijk','bcdefghijkl','cdefghijklm','abcdefghijk'].map(videoId=>({contentDetails:{videoId}}))});
   }
   assert.equal(u.searchParams.get('id'),'abcdefghijk,bcdefghijkl,cdefghijklm');
   return Response.json({items:[
    {id:'abcdefghijk',snippet:{channelId:channel,title:'Video ShopTrack'},statistics:{viewCount:'200',likeCount:'0'}},
    {id:'bcdefghijkl',snippet:{channelId:'other',title:'Other'},statistics:{viewCount:'9999'}}
   ]});
  };
  const path='video-stats?accountId='+account.id;
  assert.equal((await f.req(path,'GET',undefined,{},f.other)).status,404);
  assert.deepEqual(calls,[]);
  const report=await f.req(path);
  assert.equal(report.status,200);
  assert.equal(report.headers.get('Cache-Control'),'no-store');
  const data=await report.json();
  assert.ok(Number.isSafeInteger(data.fetchedAt));
  assert.deepEqual(data.videos,[
   {id:'abcdefghijk',title:'Video ShopTrack',views:'200',likes:'0',comments:null},
   {id:'bcdefghijkl',title:null,views:null,likes:null,comments:null},
   {id:'cdefghijklm',title:null,views:null,likes:null,comments:null}
  ]);
  assert.equal(calls.length,3);
 }finally{globalThis.fetch=prior;f.DB.sqlite.close();}
});
