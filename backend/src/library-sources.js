import {resolveShop,audit} from './shops.js';
import {encryptToken,decryptToken} from './social.js';
import {MAX_DRIVE_BYTES} from './drive.js';

const microsoft='https://login.microsoftonline.com/common/oauth2/v2.0/';
const graph='https://graph.microsoft.com/v1.0/me';
const providers={
 dropbox:{auth:'https://www.dropbox.com/oauth2/authorize',token:'https://api.dropboxapi.com/oauth2/token',scope:'account_info.read files.metadata.read files.content.read',prefix:'DROPBOX'},
 onedrive:{auth:microsoft+'authorize',token:microsoft+'token',scope:'offline_access User.Read Files.Read',prefix:'MICROSOFT'},
 email:{auth:microsoft+'authorize',token:microsoft+'token',scope:'offline_access User.Read Mail.Read',prefix:'MICROSOFT'}
};
const schema=[
 "CREATE TABLE IF NOT EXISTS library_source_states (id TEXT PRIMARY KEY, provider TEXT NOT NULL, shop TEXT NOT NULL, actor TEXT NOT NULL, verifier TEXT NOT NULL, expires INTEGER NOT NULL, claimed INTEGER NOT NULL DEFAULT 0)",
 "CREATE TABLE IF NOT EXISTS library_source_grants (provider TEXT NOT NULL, shop TEXT NOT NULL, actor TEXT NOT NULL, name TEXT NOT NULL, credential TEXT NOT NULL, iv TEXT NOT NULL, PRIMARY KEY(provider,shop,actor))"
];
const seconds=()=>Math.floor(Date.now()/1000);
const base64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const random=()=>base64(crypto.getRandomValues(new Uint8Array(32)));
const hash=async value=>base64(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))));
const fault=(code,status=502)=>Object.assign(Error(code),{code,status});
const segment=value=>encodeURIComponent(value);
const idOK=value=>typeof value==='string'&&/^[A-Za-z0-9_:/!+=.-]{1,600}$/.test(value)&&value!=='.'&&value!=='..';
const file=(id,name,size,mimeType)=>({id,name:String(name||'Tệp').slice(0,240),size:Number(size),mimeType,downloadable:Number.isSafeInteger(Number(size))&&Number(size)>=0&&Number(size)<=MAX_DRIVE_BYTES});
const mediaTypes={avif:'image/avif',gif:'image/gif',jpeg:'image/jpeg',jpg:'image/jpeg',m4v:'video/mp4',mov:'video/quicktime',mp4:'video/mp4',ogg:'video/ogg',ogv:'video/ogg',png:'image/png',webm:'video/webm',webp:'image/webp'};
const safeFetch=(url,init)=>fetch(url,{...init,redirect:'manual',signal:AbortSignal.timeout(20000)});
const bearer=token=>({Authorization:'Bearer '+token});
async function requestJSON(url,init){
 const response=await safeFetch(url,init);
 const data=await response.json().catch(()=>null);
 if(!response.ok||!data||data.error)throw fault(response.status===401||data?.error==='invalid_grant'?'source_reauthorize':'source_provider_failed',response.status===429?429:502);
 return data;
}
const graphGet=(path,token)=>requestJSON(graph+'/'+path,{headers:bearer(token)});
const dropbox=(path,token,body)=>requestJSON('https://api.dropboxapi.com/2/'+path,{method:'POST',headers:{...bearer(token),'Content-Type':'application/json'},body:JSON.stringify(body)});
const tokenRequest=(config,fields)=>requestJSON(config.token,{method:'POST',body:new URLSearchParams({client_id:config.client,client_secret:config.secret,...fields})});

async function identity(provider,token){
 if(provider==='dropbox'){
  const account=await dropbox('users/get_current_account',token,null);
  if(!account.account_id)throw fault('source_identity_failed');
  return account.name?.display_name||'Dropbox';
 }
 const account=await requestJSON(graph+'?$select=id,displayName',{headers:bearer(token)});
 if(!account.id)throw fault('source_identity_failed');
 return account.displayName||'Microsoft';
}

function nextGraphPage(link){
 if(!link)return null;
 const url=new URL(link);
 if(url.origin!=='https://graph.microsoft.com')return null;
 const token=url.searchParams.get('$skiptoken');
 const skip=url.searchParams.get('$skip');
 return token?'token:'+token:skip&&/^\d{1,8}$/.test(skip)?'skip:'+skip:null;
}
function graphPaging(query,cursor){
 if(cursor.startsWith('token:'))query.set('$skiptoken',cursor.slice(6));
 else if(/^skip:\d{1,8}$/.test(cursor))query.set('$skip',cursor.slice(5));
 else if(cursor)throw fault('source_invalid_query',400);
}

async function list(provider,token,query){
 const folder=query.get('folder')||'',cursor=query.get('pageToken')||'',q=(query.get('q')||'').toLocaleLowerCase('vi');
 if((folder&&!idOK(folder))||cursor.length>4096||q.length>200)throw fault('source_invalid_query',400);
 const matches=item=>!q||item.name.toLocaleLowerCase('vi').includes(q);
 if(provider==='dropbox'){
  const result=cursor?await dropbox('files/list_folder/continue',token,{cursor}):
   await dropbox('files/list_folder',token,{path:'',recursive:true,limit:50,include_deleted:false});
  return {files:(result.entries||[]).filter(x=>x['.tag']==='file'&&idOK(x.id)).map(x=>file(x.id,x.name,x.size)).filter(matches),folders:[],nextPageToken:result.has_more?result.cursor:null};
 }
 const params=new URLSearchParams({'$top':'30'});
 graphPaging(params,cursor);
 if(provider==='onedrive'){
  params.set('$select','id,name,size,file,folder');
  const result=await graphGet((folder?'drive/items/'+segment(folder):'drive/root')+'/children?'+params,token);
  const rows=(result.value||[]).filter(x=>idOK(x.id));
  return {files:rows.filter(x=>x.file).map(x=>file(x.id,x.name,x.size,x.file.mimeType)).filter(matches),folders:rows.filter(x=>x.folder).map(x=>({id:x.id,name:x.name})),nextPageToken:nextGraphPage(result['@odata.nextLink'])};
 }
 if(!folder){
  params.set('$select','id,subject,receivedDateTime');
  params.set('$filter','hasAttachments eq true');
  const result=await graphGet('messages?'+params,token);
  return {files:[],folders:(result.value||[]).filter(x=>idOK(x.id)).map(x=>({id:x.id,name:String(x.subject||'(Không có tiêu đề)').slice(0,240)})).filter(matches),nextPageToken:nextGraphPage(result['@odata.nextLink'])};
 }
 params.set('$select','id,name,size,contentType,isInline');
 const result=await graphGet('messages/'+segment(folder)+'/attachments?'+params,token);
 return {files:(result.value||[]).filter(x=>x['@odata.type']==='#microsoft.graph.fileAttachment'&&!x.isInline&&idOK(x.id)).map(x=>file(x.id,x.name,x.size,x.contentType)).filter(matches),folders:[],nextPageToken:nextGraphPage(result['@odata.nextLink'])};
}

async function download(provider,token,id,folder){
 if(!idOK(id)||provider==='email'&&!idOK(folder))throw fault('source_invalid_file',400);
 let meta,response;
 if(provider==='dropbox'){
  if(!id.startsWith('id:'))throw fault('source_invalid_file',400);
  meta=await dropbox('files/get_metadata',token,{path:id});
  if(meta['.tag']!=='file')throw fault('source_invalid_file',400);
  if(!file(id,meta.name,meta.size).downloadable)throw fault('source_too_large',413);
  response=await safeFetch('https://content.dropboxapi.com/2/files/download',{method:'POST',headers:{...bearer(token),'Dropbox-API-Arg':JSON.stringify({path:id})}});
 }else{
  const path=provider==='onedrive'?'drive/items/'+segment(id):'messages/'+segment(folder)+'/attachments/'+segment(id);
  meta=await graphGet(path+(provider==='onedrive'?'?$select=id,name,size,file':'?$select=id,name,size,isInline'),token);
  if(provider==='onedrive'?!meta.file:meta['@odata.type']!=='#microsoft.graph.fileAttachment'||meta.isInline)throw fault('source_invalid_file',400);
  if(!file(id,meta.name,meta.size).downloadable)throw fault('source_too_large',413);
  response=await safeFetch(graph+'/'+path+(provider==='onedrive'?'/content':'/$value'),{headers:bearer(token)});
  if(provider==='onedrive'&&response.status===302){
   const target=new URL(response.headers.get('location'));
   if(target.protocol!=='https:'||target.username||target.password||target.port||!/(^|\.)(sharepoint\.com|1drv\.com|onedrive\.com|storage\.live\.com)$/.test(target.hostname))throw fault('source_download_redirect');
   response=await safeFetch(target.href,{});
  }
 }
 if(!response.ok||!response.body)throw fault(response.status===401?'source_reauthorize':'source_download_failed');
 if(Number(response.headers.get('content-length'))>MAX_DRIVE_BYTES){await response.body.cancel();throw fault('source_too_large',413);}
 let count=0;
 const body=response.body.pipeThrough(new TransformStream({transform(chunk,controller){
  count+=chunk.byteLength;
  if(count>MAX_DRIVE_BYTES)throw fault('source_too_large',413);
  controller.enqueue(chunk);
 }}));
 const name=String(meta.name||'Tệp').replace(/[\x00-\x1f\x7f]/g,'').slice(0,240);
 let contentType=response.headers.get('content-type')||'application/octet-stream';
 if(provider==='dropbox'&&contentType.split(';',1)[0].trim().toLowerCase()==='application/octet-stream'){
  const extension=name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  contentType=mediaTypes[extension]||contentType;
 }
 return new Response(body,{headers:{'Content-Type':contentType,'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(name),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"}});
}

export async function handleLibrarySource(req,env,who,json){
 const url=new URL(req.url);
 const [,provider,action]=url.pathname.match(/^\/api\/library\/(dropbox|onedrive|email)\/(status|start|callback|connection|files|file)$/)||[];
 const fail=(code,status)=>json({code,error:code},status);
 if(!provider)return fail('not_found',404);
 const methods={status:'GET',start:'POST',callback:'GET',connection:'DELETE',files:'GET',file:'GET'};
 if(req.method!==methods[action])return fail('method_not_allowed',405);
 if(req.method!=='GET'&&req.headers.get('Origin')!==url.origin)return fail('forbidden',403);
 if(!env.DB)return fail('db_missing',503);
 const db=env.DB,definition=providers[provider];
 const config={...definition,client:env[definition.prefix+'_CLIENT_ID'],secret:env[definition.prefix+'_CLIENT_SECRET']};
 const redirect=env.PUBLIC_ORIGIN+'/api/library/'+provider+'/callback';
 const configured=Boolean(config.client&&config.secret&&env.SOCIAL_TOKEN_KEY&&env.PUBLIC_ORIGIN===url.origin&&url.protocol==='https:');
 const back=status=>new Response(null,{status:303,headers:{Location:'/?library_source='+provider+'&library_result='+status+'#library','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
 try{
  await db.batch(schema.map(sql=>db.prepare(sql)));
  let scoped=req,state;
  if(action==='callback'){
   const raw=url.searchParams.get('state');
   if(!/^[\w-]{43}$/.test(raw||''))return fail('source_invalid_state',403);
   state=await db.prepare('SELECT * FROM library_source_states WHERE id=? AND provider=? AND actor=? AND expires>? AND claimed=0').bind(await hash(raw),provider,who.owner,seconds()).first();
   if(!state)return fail('source_invalid_state',403);
   const headers=new Headers(req.headers);headers.set('X-ShopPost-Shop',state.shop);
   scoped=new Request(req,{headers});
  }
  const ctx=await resolveShop(env,who,scoped);
  if(ctx.error)return fail(ctx.code,ctx.status);
  if(ctx.shop.status!=='active')return fail('shop_inactive',403);
  const key=[provider,ctx.shop.id,who.owner];
  const grant=()=>db.prepare('SELECT * FROM library_source_grants WHERE provider=? AND shop=? AND actor=?').bind(...key).first();
  const canConnect=ctx.can('channels.configure_token');
  const canImport=ctx.can('drafts.create');
  if(action==='status'){
   if(!ctx.can('drafts.view'))return fail('forbidden',403);
   const row=await grant();
   return json({configured,connected:Boolean(row),name:row?.name||null,canConnect,canImport});
  }
  if(['start','callback','connection'].includes(action)&&!canConnect)return fail('forbidden',403);
  if(action==='connection'){
   await db.batch([
    db.prepare('DELETE FROM library_source_grants WHERE provider=? AND shop=? AND actor=?').bind(...key),
    db.prepare('DELETE FROM library_source_states WHERE provider=? AND shop=? AND actor=?').bind(...key)
   ]);
   return json({ok:true});
  }
  if(!configured)return fail('source_not_configured',503);
  if(action==='start'){
   const nonce=random(),verifier=random();
   await db.batch([
    db.prepare('DELETE FROM library_source_states WHERE expires<=? OR (provider=? AND shop=? AND actor=?)').bind(seconds(),...key),
    db.prepare('INSERT INTO library_source_states(id,provider,shop,actor,verifier,expires) VALUES(?,?,?,?,?,?)').bind(await hash(nonce),...key,verifier,seconds()+600)
   ]);
   const auth=new URL(config.auth);
   auth.search=new URLSearchParams({client_id:config.client,redirect_uri:redirect,response_type:'code',scope:config.scope,state:nonce,code_challenge:await hash(verifier),code_challenge_method:'S256',...(provider==='dropbox'?{token_access_type:'offline'}:{prompt:'select_account'})});
   return json({authorizationUrl:auth.href});
  }
  if(action==='callback'){
   const claimed=await db.prepare('UPDATE library_source_states SET claimed=1 WHERE id=? AND claimed=0 AND expires>?').bind(state.id,seconds()).run();
   if(claimed.meta.changes!==1)return fail('source_invalid_state',403);
   const code=url.searchParams.get('code');
   if(!code||code.length>4096||url.searchParams.has('error'))return back('declined');
   const token=await tokenRequest(config,{grant_type:'authorization_code',code,redirect_uri:redirect,code_verifier:state.verifier});
   const required=provider==='dropbox'?config.scope.split(' '):['User.Read',provider==='email'?'Mail.Read':'Files.Read'];
   const scopes=String(token.scope||'').toLowerCase().split(/\s+/).map(scope=>scope.replace(/^https:\/\/graph.microsoft.com\//,''));
   if(required.some(scope=>!scopes.includes(scope.toLowerCase()))||!token.access_token||!token.refresh_token||!(token.expires_in>0))return back('permission');
   const name=String(await identity(provider,token.access_token)).slice(0,100);
   const current=await resolveShop(env,who,scoped);
   if(current.error||current.shop.id!==key[1]||current.shop.status!=='active'||!current.can('channels.configure_token'))return fail('forbidden',403);
   const enc=await encryptToken(env,JSON.stringify({generation:random(),access:token.access_token,refresh:token.refresh_token,expires:seconds()+Math.min(Number(token.expires_in),86400)}));
   const saved=await db.batch([
    db.prepare('INSERT INTO library_source_grants(provider,shop,actor,name,credential,iv) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM library_source_states WHERE id=? AND claimed=1 AND expires>?) ON CONFLICT(provider,shop,actor) DO UPDATE SET name=excluded.name,credential=excluded.credential,iv=excluded.iv').bind(...key,name,enc.cipher,enc.iv,state.id,seconds()),
    db.prepare('DELETE FROM library_source_states WHERE id=?').bind(state.id)
   ]);
   if(saved[0].meta.changes!==1)return fail('source_invalid_state',403);
   await audit(db,{shopId:key[1],actor:who.owner,action:'library.'+provider+'.connect'});
   return back('connected');
  }
  if(!canImport)return fail('forbidden',403);
  const row=await grant();
  if(!row)return fail('source_connection_required',409);
  let token=JSON.parse(await decryptToken(env,row.credential,row.iv));
  if(token.expires<=seconds()+90){
   const generation=token.generation||row.credential;
   const fresh=await tokenRequest(config,{grant_type:'refresh_token',refresh_token:token.refresh,...(provider==='dropbox'?{}:{scope:config.scope})});
   if(!fresh.access_token||!(fresh.expires_in>0))throw fault('source_reauthorize');
   token={generation,access:fresh.access_token,refresh:fresh.refresh_token||token.refresh,expires:seconds()+Math.min(Number(fresh.expires_in),86400)};
   const enc=await encryptToken(env,JSON.stringify(token));
   const saved=await db.prepare('UPDATE library_source_grants SET credential=?,iv=? WHERE provider=? AND shop=? AND actor=? AND credential=?').bind(enc.cipher,enc.iv,...key,row.credential).run();
   if(saved.meta.changes===1){
    row.credential=enc.cipher;row.iv=enc.iv;
   }else{
    const current=await grant();
    if(!current)return fail('source_connection_changed',409);
    const cached=JSON.parse(await decryptToken(env,current.credential,current.iv));
    if(cached.generation!==generation||cached.expires<=seconds()+90)return fail('source_connection_changed',409);
    token=cached;row.credential=current.credential;row.iv=current.iv;
   }
  }
  const result=action==='files'?await list(provider,token.access,url.searchParams):await download(provider,token.access,url.searchParams.get('id'),url.searchParams.get('folder'));
  const current=await resolveShop(env,who,req);
  if(current.error||current.shop.id!==key[1]||current.shop.status!=='active'||!current.can('drafts.create')||(await grant())?.credential!==row.credential){
   if(result instanceof Response)await result.body?.cancel();
   return fail('source_connection_changed',409);
  }
  return action==='files'?json(result):result;
 }catch(error){
  if(action==='callback')return back('failed');
  return fail(error.code||'source_request_failed',error.status||502);
 }
}
