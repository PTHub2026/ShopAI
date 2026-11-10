import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {SESSION_COOKIE} from '../src/auth.js';
test('YouTube runs in workerd with D1 and a fixed-length video stream', {timeout:30000},async()=>{
 const bundled=await build({entryPoints:[new URL('../src/worker.js',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'browser'});
 let uploads=0;
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-11-07',cf:false,d1Databases:{DB:'google-test'},bindings:{ACCESS_TEAM_DOMAIN:'test.cloudflareaccess.com',ACCESS_AUD:'test',AI:{},SOCIAL_TOKEN_KEY:Buffer.alloc(32,4).toString('base64'),GOOGLE_CLIENT_ID:'test.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'test-secret',GOOGLE_REDIRECT_URI:'https://app.example/api/social/google/callback'},ratelimits:{AI_RATE_LIMITER:{namespace_id:'1002',simple:{limit:100,period:60}}},outboundService:async req=>{
  const url=new URL(req.url);
  if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'ACCESS',refresh_token:'REFRESH',expires_in:3600,scope:'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload'});
  if(url.pathname==='/youtube/v3/channels')return Response.json({items:[{id:'UCabcdefghijklmnopqrstuv',snippet:{title:'ShopTrack TV'}}]});
  if(url.searchParams.has('upload_id')){uploads++;assert.equal(req.headers.get('content-length'),'5');assert.equal(await req.text(),'video');return Response.json({id:'abcdefghijk'});}
  if(url.pathname==='/upload/youtube/v3/videos')return new Response(null,{status:200,headers:{Location:'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=TEST'}});
  throw Error('unexpected outbound request');
 }}));
 try{
  const db=await mf.getD1Database('DB');
  for(const file of ['0001_drafts.sql','0002_auth.sql','0003_shops_roles.sql'])await db.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8').replace(/--[^\n]*/g,'').replace(/\s+/g,' '));
  const token='A'.repeat(43),t=Math.floor(Date.now()/1000);
  await db.prepare('INSERT INTO auth_sessions(token_hash,owner,provider,created_at,expires_at) VALUES(?,?,?,?,?)').bind(createHash('sha256').update(token).digest('hex'),'email:owner@example.com','email',t,t+3600).run();
  const fetch=(path,options={})=>mf.dispatchFetch('https://app.example/api/social/google/'+path,{...options,redirect:'manual',headers:{Cookie:SESSION_COOKIE+'='+token,Origin:'https://app.example',...options.headers}});
  const start=await fetch('start',{method:'POST'});assert.equal(start.status,200);const auth=new URL((await start.json()).authorizationUrl);
  const callback=await fetch('callback?state='+auth.searchParams.get('state')+'&code=TEST');assert.equal(callback.status,303,await callback.text());
  const channel=(await (await fetch('accounts')).json()).accounts[0];
  const upload=await fetch('upload?accountId='+channel.id+'&title=Test&privacy=private&madeForKids=false',{method:'POST',headers:{'Content-Type':'video/mp4','Idempotency-Key':'runtime-upload-test'},body:'video'});
  assert.equal(upload.status,200);assert.equal((await upload.json()).videoId,'abcdefghijk');assert.equal(uploads,1);
 }finally{await mf.dispose();}
});
test('Telegram adapter works in workerd and does not follow provider redirects',{timeout:30000},async()=>{
 const bundle=await build({stdin:{contents:"import {callTelegram} from './social.js';export default {async fetch(){try{return Response.json(await callTelegram('123456:FAKE_TEST_TOKEN','getMe',{}));}catch{return new Response('rejected',{status:502});}}};",resolveDir:new URL('../src/',import.meta.url).pathname},bundle:true,write:false,format:'esm',platform:'browser'});
 let redirect=false,calls=0;
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-11-07',cf:false,outboundService:async req=>{calls++;assert.equal(new URL(req.url).hostname,'api.telegram.org');return redirect?new Response(null,{status:302,headers:{Location:'https://attacker.example'}}):Response.json({ok:true,result:{id:123456,is_bot:true}});}}));
 try{const response=await mf.dispatchFetch('https://app.example');assert.equal(response.status,200);assert.equal((await response.json()).is_bot,true);redirect=true;assert.equal((await mf.dispatchFetch('https://app.example')).status,502);assert.equal(calls,2);}finally{await mf.dispose();}
});
