// Library grants are independent of YouTube grants. Credentials never reach the browser.
import {resolveShop,audit} from './shops.js';
import {encryptToken,decryptToken} from './social.js';
export const DRIVE_SCOPE='https://www.googleapis.com/auth/drive.readonly';
export const MAX_DRIVE_BYTES=50*1024*1024;
const SCHEMA=[
 "CREATE TABLE IF NOT EXISTS drive_oauth_states(state_hash TEXT PRIMARY KEY,shop_id TEXT NOT NULL,actor TEXT NOT NULL,verifier TEXT NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending')",
 "CREATE TABLE IF NOT EXISTS drive_connections(shop_id TEXT PRIMARY KEY,external_id TEXT NOT NULL,name TEXT NOT NULL,credential TEXT NOT NULL,credential_iv TEXT NOT NULL,status TEXT NOT NULL,updated_at INTEGER NOT NULL)"
];
const now=()=>Math.floor(Date.now()/1000);
const b64=b=>btoa(String.fromCharCode(...b)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const random=()=>b64(crypto.getRandomValues(new Uint8Array(32)));
const hash=async s=>b64(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))));
const EXPORTS={
 'application/vnd.google-apps.document':['application/vnd.openxmlformats-officedocument.wordprocessingml.document','.docx'],
 'application/vnd.google-apps.spreadsheet':['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.xlsx'],
 'application/vnd.google-apps.presentation':['application/vnd.openxmlformats-officedocument.presentationml.presentation','.pptx']
};
const FILE_ID=/^[a-zA-Z0-9_-]{1,200}$/;
function problem(code,status=502){return Object.assign(Error(code),{code,status});}
export function driveConfigured(env){return /^[\w.-]+\.apps\.googleusercontent\.com$/.test(env.GOOGLE_CLIENT_ID||'')&&Boolean(env.GOOGLE_CLIENT_SECRET&&env.SOCIAL_TOKEN_KEY)&&/^https:\/\/[^/?#]+\/api\/library\/drive\/callback$/.test(env.DRIVE_REDIRECT_URI||'');}
async function providerJSON(url,init={}){
 const r=await fetch(url,{...init,redirect:'manual',signal:AbortSignal.timeout(20000)});
 const j=await r.json().catch(()=>({}));
 if(!r.ok||j.error)throw Object.assign(problem('drive_provider_failed'),{reauth:r.status===401||j.error==='invalid_grant'});
 return j;
}
const tokenRequest=(env,fields)=>providerJSON('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,...fields}).toString()});
const authHeaders=token=>({Authorization:'Bearer '+token});
async function accessToken(env,row){
 let token=JSON.parse(await decryptToken(env,row.credential,row.credential_iv));
 if(token.expiresAt>now()+90)return token.accessToken;
 const fresh=await tokenRequest(env,{grant_type:'refresh_token',refresh_token:token.refreshToken});
 if(typeof fresh.access_token!=='string'||!(fresh.expires_in>0))throw problem('drive_refresh_failed');
 const encrypted=await encryptToken(env,JSON.stringify({...token,accessToken:fresh.access_token,expiresAt:now()+Math.min(Number(fresh.expires_in),86400)}));
 const saved=await env.DB.prepare("UPDATE drive_connections SET credential=?,credential_iv=?,updated_at=? WHERE shop_id=? AND credential=? AND status='connected'").bind(encrypted.cipher,encrypted.iv,now(),row.shop_id,row.credential).run();
 if(saved.meta.changes!==1)throw problem('drive_connection_changed',409);
 row.credential=encrypted.cipher;row.credential_iv=encrypted.iv;
 return fresh.access_token;
}
function fileSummary(f){const exp=EXPORTS[f.mimeType];return {id:f.id,name:String(f.name||'File').slice(0,255),mimeType:exp?exp[0]:f.mimeType,size:f.size?Number(f.size):null,exported:Boolean(exp),downloadable:f.capabilities?.canDownload!==false&&(!String(f.mimeType).startsWith('application/vnd.google-apps.')||Boolean(exp))};}
async function currentContext(env,who,req,shop){const ctx=await resolveShop(env,who,req);if(ctx.error||ctx.shop.id!==shop||ctx.shop.status!=='active'||!ctx.can('drafts.create'))throw problem('forbidden',403);return ctx;}
export async function handleDrive(req,env,who,json){
 const fail=(code,status=400)=>json({error:code,code},status);
 if(!env.DB)return fail('db_missing',503);
 const db=env.DB,url=new URL(req.url),action=url.pathname.slice('/api/library/drive/'.length);
 if(!['status','start','callback','connection','files','file'].includes(action))return fail('not_found',404);
 await db.batch(SCHEMA.map(s=>db.prepare(s)));
 await db.prepare('DELETE FROM drive_oauth_states WHERE expires_at<=?').bind(now()).run();
 let scoped=req,stateRow,stateHash;
 if(action==='callback'){
  if(req.method!=='GET')return fail('method_not_allowed',405);
  const state=url.searchParams.get('state');if(!/^[\w-]{43}$/.test(state||''))return fail('invalid_oauth_state',403);
  stateHash=await hash(state);stateRow=await db.prepare("SELECT * FROM drive_oauth_states WHERE state_hash=? AND status='pending' AND expires_at>?").bind(stateHash,now()).first();
  if(!stateRow||stateRow.actor!==who.owner)return fail('invalid_oauth_state',403);
  const h=new Headers(req.headers);h.set('X-ShopPost-Shop',stateRow.shop_id);scoped=new Request(req,{headers:h});
 }
 let ctx=await resolveShop(env,who,scoped);
 if(ctx.error)return json({error:ctx.error,code:ctx.code},ctx.status);
 const shop=ctx.shop.id;
 if(ctx.shop.status!=='active')return fail('shop_inactive',403);
 if(action==='status'&&req.method==='GET'){
  if(!ctx.can('drafts.view'))return fail('forbidden',403);
  const row=await db.prepare('SELECT name,status FROM drive_connections WHERE shop_id=?').bind(shop).first();
  return json({configured:driveConfigured(env),connected:row?.status==='connected',name:row?.name||null,status:row?.status||'disconnected',canConnect:ctx.can('channels.configure_token'),canImport:ctx.can('drafts.create'),maxBytes:MAX_DRIVE_BYTES});
 }
 if(action==='connection'&&req.method==='DELETE'){
  if(!ctx.can('channels.configure_token'))return fail('forbidden',403);
  await db.batch([db.prepare("UPDATE drive_connections SET credential='',credential_iv='',status='revoked',updated_at=? WHERE shop_id=?").bind(now(),shop),db.prepare('DELETE FROM drive_oauth_states WHERE shop_id=?').bind(shop)]);
  await audit(db,{shopId:shop,actor:who.owner,action:'drive.disconnect'});return json({ok:true});
 }
 if(!driveConfigured(env))return fail('drive_not_configured',503);
 if(action==='start'&&req.method==='POST'){
  if(!ctx.can('channels.configure_token'))return fail('forbidden',403);
  const state=random(),verifier=random();
  await db.prepare('INSERT INTO drive_oauth_states(state_hash,shop_id,actor,verifier,expires_at) VALUES(?,?,?,?,?)').bind(await hash(state),shop,who.owner,verifier,now()+600).run();
  const auth=new URL('https://accounts.google.com/o/oauth2/v2/auth');auth.search=new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,redirect_uri:env.DRIVE_REDIRECT_URI,response_type:'code',scope:DRIVE_SCOPE,access_type:'offline',prompt:'consent',state,code_challenge:await hash(verifier),code_challenge_method:'S256'}).toString();
  return json({authorizationUrl:auth.toString()});
 }
 if(action==='callback'){
  if(!ctx.can('channels.configure_token'))return fail('forbidden',403);
  if(url.origin+url.pathname!==env.DRIVE_REDIRECT_URI)return fail('callback_origin_mismatch');
  const claimed=await db.prepare("UPDATE drive_oauth_states SET status='exchanging' WHERE state_hash=? AND status='pending' AND expires_at>?").bind(stateHash,now()).run();
  if(claimed.meta.changes!==1)return fail('oauth_state_used',403);
  const code=url.searchParams.get('code');
  if(url.searchParams.has('error')||!code||code.length>4096){await db.prepare('DELETE FROM drive_oauth_states WHERE state_hash=?').bind(stateHash).run();return new Response(null,{status:303,headers:{Location:url.origin+'/?drive_error=declined#library','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});}
  try{
   const token=await tokenRequest(env,{grant_type:'authorization_code',redirect_uri:env.DRIVE_REDIRECT_URI,code,code_verifier:stateRow.verifier});
   if(typeof token.access_token!=='string'||typeof token.refresh_token!=='string'||!token.refresh_token||!(token.expires_in>0)||!String(token.scope||'').split(' ').includes(DRIVE_SCOPE))throw problem('drive_incomplete_grant');
   const about=await providerJSON('https://www.googleapis.com/drive/v3/about?fields=user(permissionId,displayName)',{headers:authHeaders(token.access_token)});
   if(typeof about.user?.permissionId!=='string'||!about.user.permissionId)throw problem('drive_identity_missing');
   ctx=await resolveShop(env,who,scoped);if(ctx.error||!ctx.can('channels.configure_token')||ctx.shop.status!=='active')throw problem('forbidden',403);
   const encrypted=await encryptToken(env,JSON.stringify({accessToken:token.access_token,refreshToken:token.refresh_token,expiresAt:now()+Math.min(Number(token.expires_in),86400)}));
   const results=await db.batch([
    db.prepare(`INSERT INTO drive_connections(shop_id,external_id,name,credential,credential_iv,status,updated_at)
     SELECT ?,?,?,?,?,'connected',? WHERE EXISTS(SELECT 1 FROM drive_oauth_states WHERE state_hash=? AND shop_id=? AND actor=? AND status='exchanging' AND expires_at>?)
     ON CONFLICT(shop_id) DO UPDATE SET external_id=excluded.external_id,name=excluded.name,credential=excluded.credential,credential_iv=excluded.credential_iv,status='connected',updated_at=excluded.updated_at`)
     .bind(shop,about.user.permissionId,String(about.user.displayName||'Google Drive').slice(0,100),encrypted.cipher,encrypted.iv,now(),stateHash,shop,who.owner,now()),
    db.prepare('DELETE FROM drive_oauth_states WHERE state_hash=?').bind(stateHash)
   ]);
   if(results[0].meta.changes!==1)return fail('oauth_state_used',403);
   await audit(db,{shopId:shop,actor:who.owner,action:'drive.connect'});
   return new Response(null,{status:303,headers:{Location:url.origin+'/?drive_connected=1#library','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
  }catch{await db.prepare('DELETE FROM drive_oauth_states WHERE state_hash=?').bind(stateHash).run();return fail('drive_authorization_failed',422);}
 }
 if(req.method!=='GET'||!['files','file'].includes(action))return fail('method_not_allowed',405);
 if(!ctx.can('drafts.create'))return fail('forbidden',403);
 const row=await db.prepare("SELECT * FROM drive_connections WHERE shop_id=? AND status='connected'").bind(shop).first();
 if(!row)return fail('drive_connection_required',409);
 try{
  const token=await accessToken(env,row);
  if(action==='files'){
   const q=url.searchParams.get('q')||'',pageToken=url.searchParams.get('pageToken')||'';
   if(q.length>200||pageToken.length>2048)return fail('invalid_query');
   const query="trashed = false and mimeType != 'application/vnd.google-apps.folder'"+(q?" and name contains '"+q.replace(/\\/g,'\\\\').replace(/'/g,"\\'")+"'":'');
   const endpoint=new URL('https://www.googleapis.com/drive/v3/files');endpoint.search=new URLSearchParams({q:query,pageSize:'50',fields:'nextPageToken,files(id,name,mimeType,size,capabilities(canDownload))',orderBy:'modifiedTime desc',...(pageToken?{pageToken}:{})}).toString();
   const data=await providerJSON(endpoint.toString(),{headers:authHeaders(token)});
   await currentContext(env,who,req,shop);
   const active=await db.prepare("SELECT credential FROM drive_connections WHERE shop_id=? AND status='connected'").bind(shop).first();
   if(active?.credential!==row.credential)throw problem('drive_connection_changed',409);
   return json({files:(data.files||[]).filter(f=>FILE_ID.test(f.id||'')).map(fileSummary),nextPageToken:data.nextPageToken||null});
  }
  const id=url.searchParams.get('id');if(!FILE_ID.test(id||''))return fail('invalid_file_id');
  const meta=await providerJSON('https://www.googleapis.com/drive/v3/files/'+id+'?fields=id,name,mimeType,size,capabilities(canDownload)',{headers:authHeaders(token)});
  const exp=EXPORTS[meta.mimeType];
  if(meta.capabilities?.canDownload===false)return fail('drive_download_forbidden',403);
  if(String(meta.mimeType).startsWith('application/vnd.google-apps.')&&!exp)return fail('drive_file_unsupported',415);
  if(!exp&&(!Number.isSafeInteger(Number(meta.size))||Number(meta.size)<0||Number(meta.size)>MAX_DRIVE_BYTES))return fail('drive_file_too_large',413);
  await currentContext(env,who,req,shop);
  const active=await db.prepare("SELECT credential FROM drive_connections WHERE shop_id=? AND status='connected'").bind(shop).first();
  if(active?.credential!==row.credential)throw problem('drive_connection_changed',409);
  const endpoint='https://www.googleapis.com/drive/v3/files/'+id+(exp?'/export?mimeType='+encodeURIComponent(exp[0]):'?alt=media');
  const response=await fetch(endpoint,{headers:authHeaders(token),redirect:'manual',signal:AbortSignal.timeout(55000)});
  if(!response.ok||!response.body)throw Object.assign(problem('drive_download_failed'),{reauth:response.status===401});
  if(Number(response.headers.get('content-length'))>MAX_DRIVE_BYTES){await response.body.cancel();return fail('drive_file_too_large',413);}
  // Re-check after provider I/O, before returning any private bytes.
  await currentContext(env,who,req,shop);
  const still=await db.prepare("SELECT credential FROM drive_connections WHERE shop_id=? AND status='connected'").bind(shop).first();
  if(still?.credential!==row.credential){await response.body.cancel();throw problem('drive_connection_changed',409);}
  let bytes=0;
  const bounded=response.body.pipeThrough(new TransformStream({transform(chunk,controller){bytes+=chunk.byteLength;if(bytes>MAX_DRIVE_BYTES)throw Error('drive_file_too_large');controller.enqueue(chunk);}}));
  const name=(String(meta.name||'File')+(exp?exp[1]:'')).replace(/[\r\n\x00-\x1f\x7f]/g,'').slice(0,240);
  await audit(db,{shopId:shop,actor:who.owner,action:'drive.import'});
  return new Response(bounded,{headers:{'Content-Type':exp?exp[0]:(meta.mimeType||'application/octet-stream'),'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(name),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY'}});
 }catch(e){
  if(e.reauth)await db.prepare("UPDATE drive_connections SET status='reauth_required' WHERE shop_id=? AND credential=?").bind(shop,row.credential).run();
  return fail(e.code||'drive_request_failed',e.status||502);
 }
}
