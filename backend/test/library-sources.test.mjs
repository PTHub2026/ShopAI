import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {sqliteDB} from './sqlite-fixture.mjs';
import worker from '../src/worker.js';
import {SESSION_COOKIE} from '../src/auth.js';

const origin='https://shoppost.example';
function fixture(){
 const DB=sqliteDB();
 const now=Math.floor(Date.now()/1000);
 const env={DB,AI:{},AI_RATE_LIMITER:{},ACCESS_TEAM_DOMAIN:'test.cloudflareaccess.com',ACCESS_AUD:'test',PUBLIC_ORIGIN:origin,SOCIAL_TOKEN_KEY:Buffer.alloc(32,3).toString('base64'),DROPBOX_CLIENT_ID:'test',DROPBOX_CLIENT_SECRET:'secret',MICROSOFT_CLIENT_ID:'ms-test',MICROSOFT_CLIENT_SECRET:'secret'};
 function login(user){
  const token=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  DB.sqlite.prepare('INSERT INTO auth_sessions(token_hash,owner,provider,created_at,expires_at) VALUES(?,?,?,?,?)').run(createHash('sha256').update(token).digest('hex'),'email:'+user+'@example.com','email',now,now+3600);
  return SESSION_COOKIE+'='+token;
 }
 const owner=login('owner'),other=login('other');
 const call=(path,method='GET',cookie=owner,extra={})=>worker.fetch(new Request(origin+'/api/library/'+path,{method,headers:{Origin:origin,Cookie:cookie,...extra}}),env);
 return {call,env,DB,other};
}
async function start(f,source){
 const r=await f.call(source+'/start','POST');
 assert.equal(r.status,200);
 const auth=new URL((await r.json()).authorizationUrl);
 assert.equal(auth.searchParams.get('code_challenge_method'),'S256');
 return auth;
}
const callback=(source,auth)=>source+'/callback?state='+auth.searchParams.get('state')+'&code=sample';
const creds=scope=>Response.json({access_token:'PRIVATE_ACCESS',refresh_token:'PRIVATE_REFRESH',expires_in:3600,scope});
test('Dropbox OAuth and import use actor-bound one-use PKCE and encrypted storage',async()=>{
 const f=fixture(),fetchBefore=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{
  const {hostname,pathname}=new URL(url);
  if(pathname==='/oauth2/token'){
   assert.equal(init.body.get('code'),'sample');
   assert.ok(init.body.get('code_verifier'));
   return creds('account_info.read files.metadata.read files.content.read');
  }
  assert.equal(init.headers.Authorization,'Bearer PRIVATE_ACCESS');
  if(pathname.endsWith('get_current_account'))return Response.json({account_id:'id1',name:{display_name:'Test Dropbox'}});
  if(pathname.endsWith('list_folder'))return Response.json({entries:[{'.tag':'file',id:'id:abc',name:'file.txt',size:5}],has_more:true,cursor:'opaque'});
  if(pathname.endsWith('get_metadata'))return Response.json({'.tag':'file',name:'file.txt',size:5});
  if(hostname==='content.dropboxapi.com')return new Response('hello');
  throw Error(pathname);
 };
 try{
  const auth=await start(f,'dropbox');
  const cb=callback('dropbox',auth);
  assert.equal((await f.call(cb,'GET',f.other)).status,403);
  const response=await f.call(cb);
  assert.match(response.headers.get('location'),/library_result=connected/);
  assert.equal((await f.call(cb)).status,403);
  assert.doesNotMatch(f.DB.sqlite.prepare('SELECT credential FROM library_source_grants').get().credential,/PRIVATE/);
  const list=await (await f.call('dropbox/files')).json();
  assert.equal(list.files[0].name,'file.txt');
  assert.equal(list.nextPageToken,'opaque');
  assert.equal((await f.call('dropbox/files','GET',f.other)).status,409);
  const bytes=await f.call('dropbox/file?id=id%3Aabc');
  assert.match(bytes.headers.get('content-disposition'),/attachment/);
  assert.equal(await bytes.text(),'hello');
  assert.equal((await f.call('dropbox/connection','DELETE')).status,200);
  assert.equal((await f.call('dropbox/files')).status,409);
 }finally{globalThis.fetch=fetchBefore;f.DB.sqlite.close();}
});
test('Microsoft OneDrive and Outlook use separate scopes and safe file downloads',async()=>{
 const f=fixture(),fetchBefore=globalThis.fetch;
 let source='onedrive';
 globalThis.fetch=async(url,init)=>{
  const {hostname,pathname}=new URL(url);
  if(pathname.endsWith('/token'))return creds('User.Read '+(source==='onedrive'?'Files.Read':'Mail.Read'));
  if(hostname==='test.sharepoint.com'){
   assert.equal(init.headers,undefined);
   return new Response('drive');
  }
  assert.equal(init.headers.Authorization,'Bearer PRIVATE_ACCESS');
  if(pathname.endsWith('/me'))return Response.json({id:'person',displayName:'Microsoft Test'});
  if(pathname.endsWith('/children'))return Response.json({value:[{id:'folder',name:'Folder',folder:{}},{id:'doc',name:'Doc.txt',size:5,file:{mimeType:'text/plain'}}]});
  if(pathname.endsWith('/doc/content'))return new Response(null,{status:302,headers:{Location:'https://test.sharepoint.com/file'}});
  if(pathname.endsWith('/doc'))return Response.json({name:'Doc.txt',size:5,file:{}});
  if(pathname.endsWith('/messages'))return Response.json({value:[{id:'message',subject:'Test message'}]});
  if(pathname.endsWith('/attachments'))return Response.json({value:[{id:'attach',name:'Attachment.txt',size:4,'@odata.type':'#microsoft.graph.fileAttachment'},{id:'inline',name:'Inline',size:5,isInline:true,'@odata.type':'#microsoft.graph.fileAttachment'}]});
  if(pathname.endsWith('/attach'))return Response.json({name:'Attachment.txt',size:4,'@odata.type':'#microsoft.graph.fileAttachment'});
  if(pathname.endsWith('/$value'))return new Response('mail');
  throw Error(pathname);
 };
 try{
  const drive=await start(f,'onedrive');
  assert.match(drive.searchParams.get('scope'),/Files.Read/);
  assert.doesNotMatch(drive.searchParams.get('scope'),/Mail.Read/);
  assert.match((await f.call(callback('onedrive',drive))).headers.get('location'),/connected/);
  assert.equal((await (await f.call('onedrive/files')).json()).folders[0].name,'Folder');
  assert.equal(await (await f.call('onedrive/file?id=doc')).text(),'drive');
  assert.equal((await f.call('email/files')).status,409);
  source='email';
  const outlook=await start(f,'email');
  assert.match(outlook.searchParams.get('scope'),/Mail.Read/);
  assert.doesNotMatch(outlook.searchParams.get('scope'),/Files.Read/);
  assert.match((await f.call(callback('email',outlook))).headers.get('location'),/connected/);
  assert.equal((await (await f.call('email/files')).json()).folders[0].id,'message');
  assert.equal((await (await f.call('email/files?folder=message')).json()).files.length,1);
  assert.equal(await (await f.call('email/file?folder=message&id=attach')).text(),'mail');
 }finally{globalThis.fetch=fetchBefore;f.DB.sqlite.close();}
});
test('unconfigured sources and cross-origin mutations fail closed',async()=>{
 const f=fixture();
 try{
  delete f.env.MICROSOFT_CLIENT_SECRET;
  const status=await (await f.call('email/status')).json();
  assert.equal(status.configured,false);
  assert.equal(status.connected,false);
  assert.equal((await f.call('email/start','POST')).status,503);
  assert.equal((await f.call('dropbox/start','POST',undefined,{Origin:'https://other.example'})).status,403);
 }finally{f.DB.sqlite.close();}
});
