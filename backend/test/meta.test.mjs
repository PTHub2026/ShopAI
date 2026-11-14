import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {encryptToken} from '../src/social.js';
import {publishMeta,metaConfigured,META_SCHEMA,handleMeta} from '../src/meta.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const token='EAAX-SYNTHETIC-ONLY',env=()=>({SOCIAL_TOKEN_KEY:Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64'),META_APP_ID:'1234567890',META_APP_SECRET:'test-placeholder',META_REDIRECT_URI:'https://shoppost.example/api/social/meta/callback',META_GRAPH_VERSION:'v26.0'});
test('Meta configuration requires app ID, server-side secret and exact HTTPS callback',()=>{
 assert.equal(metaConfigured(env()),true);
 assert.equal(metaConfigured({...env(),META_APP_SECRET:''}),false);
 assert.equal(metaConfigured({...env(),META_REDIRECT_URI:'http://shoppost.example/api/social/meta/callback'}),false);
});
test('Meta schema migration matches runtime and never stores plaintext auth code',()=>{
 const sqlite=new DatabaseSync(':memory:');
 for(const s of META_SCHEMA)sqlite.exec(s);
 const migration=readFileSync(new URL('../migrations/0009_meta_oauth.sql',import.meta.url),'utf8');
 assert.match(migration,/state_hash TEXT PRIMARY KEY/);
 sqlite.exec(migration);
 assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='meta_oauth_states'").get().n,1);
 assert.match(readFileSync(new URL('../src/meta.js',import.meta.url),'utf8'),/DELETE FROM meta_oauth_states WHERE state_hash=\?/);
 sqlite.close();
});
test('Facebook Pages text and photo publish; Instagram requires an image and publishes media container',async()=>{
 const e=env(),enc=await encryptToken(e,token),a={provider:'facebook',external_id:'123456',token:enc.cipher,token_iv:enc.iv};
 const fetch0=globalThis.fetch,requests=[];
 globalThis.fetch=async(url,options)=>{const u=new URL(url);requests.push({u,options});assert.equal(u.hostname,'graph.facebook.com');assert.equal(options.headers.Authorization,'Bearer '+token);assert.equal(u.searchParams.has('access_token'),false);const p=new URLSearchParams(options.body||'');assert.equal(p.has('access_token'),false);
 if(u.pathname.endsWith('/feed')){assert.equal(p.get('message'),'A test text');return Response.json({id:'post_1'});}
 if(u.pathname.endsWith('/photos')){assert.equal(p.get('url'),'https://example.com/photo.jpg');return Response.json({post_id:'post_2'});}
 if(u.pathname.endsWith('/container_1')){assert.equal(options.method,'GET');assert.equal(u.searchParams.get('fields'),'status_code');return Response.json({status_code:'FINISHED'});}
 if(u.pathname.endsWith('/media_publish')){assert.equal(p.get('creation_id'),'container_1');return Response.json({id:'ig_1'});}
 if(u.pathname.endsWith('/media')){assert.equal(p.get('image_url'),'https://example.com/photo.jpg');return Response.json({id:'container_1'});}
 throw Error('Unexpected graph endpoint');};
 try{
  assert.equal(await publishMeta(e,a,{kind:'text',payload:JSON.stringify({text:'A test text'})}),'post_1');
  assert.equal(await publishMeta(e,a,{kind:'photo',payload:JSON.stringify({text:'Caption',photoUrl:'https://example.com/photo.jpg'})}),'post_2');
  const ig={...a,provider:'instagram',external_id:'987654'};
  await assert.rejects(publishMeta(e,ig,{kind:'text',payload:JSON.stringify({text:'No picture'})}),/IG_REQUIRES_PHOTO/);
  assert.equal(await publishMeta(e,ig,{kind:'photo',payload:JSON.stringify({text:'Caption',photoUrl:'https://example.com/photo.jpg'})}),'ig_1');
  assert.deepEqual(requests.map(x=>x.u.pathname.split('/').at(-1)),['feed','photos','media','container_1','media_publish']);
 }finally{globalThis.fetch=fetch0;}
});
test('OAuth callback refuses missing configuration before touching database',async()=>{
 const r=await handleMeta(new Request('https://shoppost.example/api/social/meta/callback'),{...env(),META_APP_SECRET:''},{owner:'user'},(v,s=200)=>Response.json(v,{status:s}));
 assert.equal(r.status,503);
});

test('Instagram ERROR or EXPIRED container marks publish job failed permanently, not unknown',async()=>{
 const {retryDecision}=await import('../src/provider-adapters.js');
 const e=env(),enc=await encryptToken(e,token),account={provider:'instagram',external_id:'987654',token:enc.cipher,token_iv:enc.iv};
 for(const code of ['ERROR','EXPIRED']){
  const original=globalThis.fetch;
  globalThis.fetch=async(url)=>{const path=new URL(url).pathname.split('/').at(-1);if(path==='media')return Response.json({id:'c1'});if(path==='c1')return Response.json({status_code:code});throw Error('must not publish');};
  try{
   await assert.rejects(publishMeta(e,account,{kind:'photo',payload:JSON.stringify({text:'hi',photoUrl:'https://example.com/img.jpg'})}),err=>{const d=retryDecision(err,1);return err.message==='IG_MEDIA_UNAVAILABLE'&&err.permanent===true&&d.status==='failed';});
  }finally{globalThis.fetch=original;}
 }
});
test('Instagram never calls media_publish until container reaches FINISHED',async()=>{
 const e=env(),enc=await encryptToken(e,token),account={provider:'instagram',external_id:'987654',token:enc.cipher,token_iv:enc.iv};
 const original=globalThis.fetch,called=[];
 globalThis.fetch=async(url)=>{
  const path=new URL(url).pathname.split('/').at(-1);called.push(path);
  if(path==='media')return Response.json({id:'container_1'});
  if(path==='container_1')return Response.json({status_code:'IN_PROGRESS'});
  throw Error('Unexpected publish');
 };
 try{
  await assert.rejects(publishMeta(e,account,{kind:'photo',payload:JSON.stringify({text:'Caption',photoUrl:'https://example.com/img.jpg'})}),e=>e.message==='IG_MEDIA_PROCESSING'&&e.status===429&&e.retryAfter===30);
  assert.deepEqual(called,['media','container_1']);
 }finally{globalThis.fetch=original;}
});

test('Facebook uploads local images unpublished and attaches every image to one confirmed post',async()=>{
 const e=env(),enc=await encryptToken(e,token),a={provider:'facebook',external_id:'123456',token:enc.cipher,token_iv:enc.iv};
 const images=['data:image/png;base64,iVBORw0KGgo=','data:image/jpeg;base64,/9j/AA=='],original=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,options)=>{
  calls.push(String(url));assert.equal(options.headers.Authorization,'Bearer '+token);assert.equal(String(url).includes(token),false);
  if(String(url).endsWith('/photos')){assert.ok(options.body instanceof FormData);assert.equal(options.body.get('published'),'false');assert.ok(options.body.get('source') instanceof Blob);return Response.json({id:String(100+calls.length)});}
  const p=new URLSearchParams(options.body);assert.equal(p.get('message'),'Long caption '.repeat(150));assert.deepEqual(JSON.parse(p.get('attached_media')), [{media_fbid:'101'},{media_fbid:'102'}]);return Response.json({id:'123456_999'});
 };
 try{assert.equal(await publishMeta(e,a,{kind:'photo',payload:JSON.stringify({text:'Long caption '.repeat(150),images})}),'123456_999');assert.equal(calls.length,3);}finally{globalThis.fetch=original;}
});
test('Facebook never publishes an album if an upload fails',async()=>{
 const e=env(),enc=await encryptToken(e,token),a={provider:'facebook',external_id:'123456',token:enc.cipher,token_iv:enc.iv};
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async(url)=>{assert.ok(String(url).endsWith('/photos'));calls++;return calls===1?Response.json({id:'101'}):Response.json({error:{code:100}},{status:400});};
 try{await assert.rejects(publishMeta(e,a,{kind:'photo',payload:JSON.stringify({text:'Album',images:['https://example.com/1.jpg','https://example.com/2.jpg']})}));assert.equal(calls,2);}finally{globalThis.fetch=original;}
});
