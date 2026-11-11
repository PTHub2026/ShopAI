// Meta OAuth for Facebook Pages + linked Instagram Professional accounts.
// Never log authorization codes, OAuth access tokens or response bodies from Graph.
import {resolveShop,audit} from './shops.js';
import {encryptToken,decryptToken} from './social.js';
import {normalizeImages} from './provider-adapters.js';
export const META_SCHEMA = [
 "CREATE TABLE IF NOT EXISTS meta_oauth_states (state_hash TEXT PRIMARY KEY, shop_id TEXT NOT NULL, actor TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)",
 "CREATE INDEX IF NOT EXISTS meta_oauth_expires ON meta_oauth_states(expires_at)"
];
const stamp=()=>Math.floor(Date.now()/1000);
const bytesToHex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const sha=async s=>bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))));
const random=()=>btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const version=e=>/^v\d{1,2}\.0$/.test(e.META_GRAPH_VERSION||'')?e.META_GRAPH_VERSION:'v26.0';
const graph=(e,path)=>'https://graph.facebook.com/'+version(e)+'/'+path;
const appId=e=>e.META_APP_ID||e.FACEBOOK_APP_ID;
const appSecret=e=>e.META_APP_SECRET||e.FACEBOOK_APP_SECRET;
export function metaConfigured(e){
 return /^\d{5,20}$/.test(String(appId(e)||''))&&Boolean(appSecret(e))&&
 typeof e.META_REDIRECT_URI==='string'&&/^https:\/\/[^/?#]+\/api\/social\/meta\/callback$/.test(e.META_REDIRECT_URI)&&
 Boolean(e.SOCIAL_TOKEN_KEY);
}
function form(obj){return new URLSearchParams(obj);}
export async function graphRequest(e,path,token,fields={},method='GET'){
 const uri=new URL(graph(e,path));
 let init={method,redirect:'manual',signal:AbortSignal.timeout(12000)};
 // Keep Graph access tokens out of URLs, browser history and edge request logs.
 init.headers={Authorization:'Bearer '+token};
 if(method==='GET'){uri.search=form(fields).toString();}
 else if(fields instanceof FormData){init.body=fields;}
 else {init.headers['Content-Type']='application/x-www-form-urlencoded';init.body=form(fields).toString();}
 const r=await fetch(uri,init);const data=await r.json().catch(()=>({}));
 if(!r.ok||data.error){const err=Error('META_API_FAILED');err.status=r.status;err.code=data.error?.code;err.subcode=data.error?.error_subcode;throw err;}
 return data;
}
export async function publishMeta(e,account,job){
 const token=await decryptToken(e,account.token,account.token_iv);
 const p=JSON.parse(job.payload);
 if(account.provider==='facebook'){
  if(job.kind==='text'){
   const r=await graphRequest(e,encodeURIComponent(account.external_id)+'/feed',token,{message:p.text},'POST');
   if(!r.id)throw Error('META_MISSING_ID');return String(r.id);
  }
  if(Array.isArray(p.images)&&p.images.length){
   const attachments=[];
   // Stage every image unpublished; only the final feed call makes the album visible.
   for(const image of normalizeImages(p.images)){
    const fields=new FormData();fields.set('published','false');
    if(image.kind==='upload')fields.set('source',new Blob([image.bytes],{type:image.mime}),image.name);
    else fields.set('url',image.url);
    const uploaded=await graphRequest(e,encodeURIComponent(account.external_id)+'/photos',token,fields,'POST');
    if(!uploaded.id)throw Error('META_MISSING_PHOTO_ID');
    attachments.push({media_fbid:String(uploaded.id)});
   }
   if(!attachments.length)throw Error('META_MISSING_PHOTO_ID');
   const posted=await graphRequest(e,encodeURIComponent(account.external_id)+'/feed',token,{message:p.text,attached_media:JSON.stringify(attachments)},'POST');
   if(!posted.id)throw Error('META_MISSING_ID');return String(posted.id);
  }
  const r=await graphRequest(e,encodeURIComponent(account.external_id)+'/photos',token,{url:p.photoUrl,caption:p.text},'POST');
  if(!r.post_id&&!r.id)throw Error('META_MISSING_ID');return String(r.post_id||r.id);
 }
 if(account.provider==='instagram'){
  if(job.kind!=='photo')throw Error('IG_REQUIRES_PHOTO');
  // Container creation is not publishing; once the publish call starts, network uncertainty is not retried.
  const container=await graphRequest(e,encodeURIComponent(account.external_id)+'/media',token,{image_url:p.photoUrl,caption:p.text},'POST');
  if(!container.id)throw Error('META_MISSING_CONTAINER');
  // Instagram media creation can be asynchronous. Never publish an unready container.
  const status=await graphRequest(e,encodeURIComponent(String(container.id)),token,{fields:'status_code'});
  if(status.status_code!=='FINISHED'){
   if(status.status_code==='IN_PROGRESS'){
    const wait=Error('IG_MEDIA_PROCESSING');wait.status=429;wait.retryAfter=30;throw wait;
   }
   throw Error('IG_MEDIA_UNAVAILABLE');
  }
  const publish=await graphRequest(e,encodeURIComponent(account.external_id)+'/media_publish',token,{creation_id:String(container.id)},'POST');
  if(!publish.id)throw Error('META_MISSING_ID');return String(publish.id);
 }
 throw Error('UNSUPPORTED_PROVIDER');
}
export function metaDenied(e){return e?.status===401||e?.code===190||e?.code===10||e?.code===200;}
async function saveAccount(db,env,who,shop,provider,item,token){
 const t=stamp(),secret=await encryptToken(env,token),id='sa_'+crypto.randomUUID();
 await db.prepare("INSERT INTO channels(id,shop_id,provider,name,external_id,token,token_iv,status,connected_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'connected',?,?,?) ON CONFLICT(shop_id,provider,external_id) DO UPDATE SET name=excluded.name,token=excluded.token,token_iv=excluded.token_iv,status='connected',updated_at=excluded.updated_at")
 .bind(id,shop,provider,String(item.name||item.username||provider).slice(0,80),String(item.id),secret.cipher,secret.iv,who.owner,t,t).run();
 await audit(db,{shopId:shop,actor:who.owner,action:'social.connect',target:String(item.id),detail:{provider}});
}
// Instagram can be linked to a Page after the Meta OAuth consent. Detect it from stored
// Page tokens so the Chủ shop does not have to reconnect. Tokens never go into URLs:
// debug_token is called with POST + method=GET, authenticated by the app token header.
async function tokenScopes(e,token){
 const r=await graphRequest(e,'debug_token',appId(e)+'|'+appSecret(e),{input_token:token,method:'GET'},'POST');
 const d=r.data||{};
 if(!d.is_valid)throw Object.assign(Error('META_TOKEN_INVALID'),{code:190});
 return new Set(Array.isArray(d.scopes)?d.scopes.map(String):[]);
}
export async function syncInstagramFromPages(env,db,{shopId=null,actor=null,manual=false}={}){
 const out={pages:0,linked:0,connected:0,alreadyConnected:0,missingPermission:0,reauth:0,errors:0};
 if(!db||!metaConfigured(env))return out;
 const {results}=await db.prepare("SELECT c.shop_id,c.external_id,c.token,c.token_iv,c.connected_by FROM channels c JOIN shops s ON s.id=c.shop_id WHERE c.provider='facebook' AND c.status='connected' AND c.token IS NOT NULL AND c.token<>'' AND s.status='active' AND (? IS NULL OR c.shop_id=?) ORDER BY c.updated_at DESC LIMIT 50").bind(shopId,shopId).all();
 for(const page of results||[]){
  if(!/^\d+$/.test(String(page.external_id||'')))continue;
  out.pages++;
  try{
   const token=await decryptToken(env,page.token,page.token_iv);
   const info=await graphRequest(env,encodeURIComponent(page.external_id),token,{fields:'instagram_business_account{id,username}'});
   const ig=info.instagram_business_account;
   if(!ig||!/^\d+$/.test(String(ig.id||'')))continue;
   out.linked++;
   const existing=await db.prepare("SELECT status FROM channels WHERE shop_id=? AND provider='instagram' AND external_id=?").bind(page.shop_id,String(ig.id)).first();
   if(existing?.status==='connected'){out.alreadyConnected++;continue;}
   // Background sync never revives a channel the Chủ shop disconnected; only an explicit click does.
   if(existing&&!manual)continue;
   const scopes=await tokenScopes(env,token);
   if(!scopes.has('instagram_basic')||!scopes.has('instagram_content_publish')){out.missingPermission++;continue;}
   await saveAccount(db,env,{owner:actor||page.connected_by||'system:meta-sync'},page.shop_id,'instagram',{id:ig.id,name:ig.username||'Instagram'},token);
   out.connected++;
  }catch(e){
   // Page token bị thu hồi/hết hạn (Chủ shop gỡ app, đổi mật khẩu, mất quyền Trang): báo "Cần cấp quyền lại"
   // ngay thay vì chờ tới lúc bài hẹn giờ đăng thất bại. Chỉ mã 190 mới là token hỏng; lỗi quyền (10/200) giữ nguyên.
   if(Number(e?.code)===190){
    const marked=await db.prepare("UPDATE channels SET status='reauth_required',updated_at=? WHERE shop_id=? AND provider='facebook' AND external_id=? AND status='connected' AND token IS ?").bind(stamp(),page.shop_id,String(page.external_id),page.token).run().catch(()=>null);
    if(marked?.meta?.changes){out.reauth++;await audit(db,{shopId:page.shop_id,actor:'system:meta-health',action:'social.reauth_required',target:String(page.external_id),detail:{provider:'facebook'}}).catch(()=>{});continue;}
   }
   out.errors++;
   console.warn(JSON.stringify({event:'meta_ig_sync_failed',stage:String(e?.message||'unknown').slice(0,40),status:Number(e?.status)||0,code:Number(e?.code)||0}));
  }
 }
 return out;
}
const error=(json,code,status=400)=>json({error:code,code},status);
const CALLBACK_CODES=new Set(['meta_not_configured','db_missing','invalid_oauth_state','invalid_or_expired_state','oauth_state_used','oauth_declined','meta_scope_denied','meta_authorization_failed','forbidden','callback_origin_mismatch','method_not_allowed']);
function callbackErrorPage(code,status){
 const safe=CALLBACK_CODES.has(code)?code:'meta_authorization_failed';
 const back='/?meta_error='+encodeURIComponent(safe)+'#accounts';
 const html='<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url='+back+'"><title>Chưa kết nối được Facebook / Instagram</title></head><body><p>Chưa kết nối được Facebook / Instagram. Đang quay lại Shoppost…</p><p><a href="'+back+'">Quay lại Shoppost</a></p></body></html>';
 return new Response(html,{status,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"}});
}
export async function handleMeta(req,env,who,json){
 const res=await handleMetaRequest(req,env,who,json);
 const isCallback=new URL(req.url).pathname.endsWith('/callback')&&req.method==='GET';
 if(!isCallback||res.status<400)return res;
 const body=await res.clone().json().catch(()=>({}));
 return callbackErrorPage(String(body.code||body.error||''),res.status);
}
async function handleMetaRequest(req,env,who,json){
 if(!metaConfigured(env))return error(json,'meta_not_configured',503);
 if(!env.DB)return error(json,'db_missing',503);
 const url=new URL(req.url),segments=url.pathname.split('/'),act=segments.at(-1);
 if(!['start','callback','sync'].includes(act))return error(json,'not_found',404);
 const db=env.DB;
 await db.batch(META_SCHEMA.map(s=>db.prepare(s)));
 let scopedRequest=req;
 if(act==='callback'){
  const state=url.searchParams.get('state');
  if(!state||!/^(?:m_)?[-_A-Za-z0-9]{43}$/.test(state))return error(json,'invalid_oauth_state',400);
  const prior=await db.prepare('SELECT shop_id,actor FROM meta_oauth_states WHERE state_hash=?').bind(await sha(state)).first();
  if(!prior||prior.actor!==who.owner)return error(json,'invalid_oauth_state',403);
  const headers=new Headers(req.headers);headers.set('X-ShopPost-Shop',prior.shop_id);
  scopedRequest=new Request(req,{headers});
 }
 const ctx=await resolveShop(env,who,scopedRequest);
 if(ctx.error)return json({error:ctx.error,code:ctx.code},ctx.status);
 if(act==='sync'){
  if(req.method!=='POST')return error(json,'method_not_allowed',405);
  if(!ctx.can('channels.configure_token')||ctx.shop.status!=='active')return error(json,'forbidden',403);
  return json({ok:true,...await syncInstagramFromPages(env,db,{shopId:ctx.shop.id,actor:who.owner,manual:true})});
 }
 if(act==='start'){
  if(req.method!=='POST')return error(json,'method_not_allowed',405);
  if(!ctx.can('channels.configure_token')||ctx.shop.status!=='active')return error(json,'forbidden',403);
  const messenger=url.searchParams.get('purpose')==='messenger';
  const state=(messenger?'m_':'')+random(),t=stamp();
  await db.prepare('INSERT INTO meta_oauth_states(state_hash,shop_id,actor,expires_at,created_at) VALUES(?,?,?,?,?)').bind(await sha(state),ctx.shop.id,who.owner,t+600,t).run();
  const auth=new URL('https://www.facebook.com/'+version(env)+'/dialog/oauth');
  // Business-type Meta apps use Facebook Login for Business: permissions come from a
  // Dashboard configuration (config_id) instead of the scope parameter.
  const configId=String((messenger&&env.META_MESSENGER_LOGIN_CONFIG_ID)||env.META_LOGIN_CONFIG_ID||'').trim();
  if(messenger&&configId&&!env.META_MESSENGER_LOGIN_CONFIG_ID)return error(json,'meta_messenger_login_not_configured',503);
  const params={client_id:appId(env),redirect_uri:env.META_REDIRECT_URI,response_type:'code',state};
  if(/^\d{5,20}$/.test(configId))params.config_id=configId;
  else {
   params.scope='pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish';
   if(messenger){params.scope+=',pages_messaging,pages_manage_metadata';params.auth_type='rerequest';}
  }
  auth.search=new URLSearchParams(params).toString();
  return json({authorizationUrl:auth.toString()});
 }
 if(req.method!=='GET')return error(json,'method_not_allowed',405);
 // Permissions may be removed while the user completes the OAuth consent screen.
 if(!ctx.can('channels.configure_token')||ctx.shop.status!=='active')return error(json,'forbidden',403);
 if(url.origin!==new URL(env.META_REDIRECT_URI).origin||url.pathname!==new URL(env.META_REDIRECT_URI).pathname)return error(json,'callback_origin_mismatch',400);
 const state=url.searchParams.get('state'),code=url.searchParams.get('code');
 if(!state||!/^(?:m_)?[-_A-Za-z0-9]{43}$/.test(state))return error(json,'invalid_oauth_state',400);
 const hash=await sha(state);
 const row=await db.prepare('SELECT shop_id,actor,expires_at FROM meta_oauth_states WHERE state_hash=?').bind(hash).first();
 if(!row||row.actor!==who.owner||row.shop_id!==ctx.shop.id||row.expires_at<=stamp())return error(json,'invalid_or_expired_state',403);
 // Atomic consume before any outbound token exchange: callback replay is denied.
 const consumed=await db.prepare('DELETE FROM meta_oauth_states WHERE state_hash=? AND shop_id=? AND actor=? AND expires_at>?').bind(hash,ctx.shop.id,who.owner,stamp()).run();
 if(consumed.meta.changes!==1)return error(json,'oauth_state_used',403);
 if(!code||code.length>2048)return error(json,'oauth_declined',400);
 const messenger=state.length===45;
 let pages;
 try {
  const tokenUrl=new URL(graph(env,'oauth/access_token'));
  tokenUrl.search=new URLSearchParams({client_id:appId(env),client_secret:appSecret(env),redirect_uri:env.META_REDIRECT_URI,code}).toString();
  const tokenResp=await fetch(tokenUrl,{redirect:'manual',signal:AbortSignal.timeout(12000)});
  const tokenData=await tokenResp.json().catch(()=>({}));
  if(!tokenResp.ok||typeof tokenData.access_token!=='string'){const err=Error('META_TOKEN_FAILED');err.status=tokenResp.status;err.code=tokenData.error?.code;err.subcode=tokenData.error?.error_subcode;throw err;}
  // Exchange short-lived token before deriving page tokens.
  const longUrl=new URL(graph(env,'oauth/access_token'));
  longUrl.search=new URLSearchParams({grant_type:'fb_exchange_token',client_id:appId(env),client_secret:appSecret(env),fb_exchange_token:tokenData.access_token}).toString();
  const longResp=await fetch(longUrl,{redirect:'manual',signal:AbortSignal.timeout(12000)});
  const long=await longResp.json().catch(()=>({}));
  if(!longResp.ok||typeof long.access_token!=='string'){const err=Error('META_LONG_TOKEN_FAILED');err.status=longResp.status;err.code=long.error?.code;err.subcode=long.error?.error_subcode;throw err;}
  const permissions=await graphRequest(env,'me/permissions',long.access_token,{limit:'100'});
  const granted=new Set((Array.isArray(permissions.data)?permissions.data:[]).filter(p=>p.status==='granted').map(p=>p.permission));
  if(!granted.has('pages_show_list')||!granted.has('pages_manage_posts'))throw Error('META_PAGE_SCOPE_DENIED');
  if(messenger&&(!granted.has('pages_messaging')||!granted.has('pages_manage_metadata')))throw Error('META_PAGE_SCOPE_DENIED');
  const canUseInstagram=granted.has('instagram_basic')&&granted.has('instagram_content_publish');
  pages=await graphRequest(env,'me/accounts',long.access_token,{fields:'id,name,access_token,instagram_business_account{id,username}',limit:'100'});
  const items=Array.isArray(pages.data)?[...pages.data]:[];
  const seenCursors=new Set();
  // Page inventory may span multiple pages; never report partial authorization as complete.
  for(let pageNo=1;pages.paging?.next;pageNo++){
   const after=pages.paging?.cursors?.after;
   if(pageNo>=10||!after||seenCursors.has(after)||typeof after!=='string'||after.length>1024)throw Error('META_PAGE_LIST_INCOMPLETE');
   seenCursors.add(after);
   pages=await graphRequest(env,'me/accounts',long.access_token,{fields:'id,name,access_token,instagram_business_account{id,username}',limit:'100',after});
   if(!Array.isArray(pages.data))throw Error('META_PAGE_LIST_INVALID');
   items.push(...pages.data);
  }
  pages={data:items,canUseInstagram};
 }catch(e){
  // Safe diagnostics only: internal stage + Graph error numbers. Never codes, tokens or Graph bodies.
  console.warn(JSON.stringify({event:'meta_oauth_failed',stage:String(e?.message||'unknown').slice(0,40),status:Number(e?.status)||0,code:Number(e?.code)||0,subcode:Number(e?.subcode)||0}));
  if(e?.message==='META_PAGE_SCOPE_DENIED')return error(json,'meta_scope_denied',403);
  return error(json,'meta_authorization_failed',502);
 }
 const current=await resolveShop(env,who,scopedRequest);
 if(current.error||current.shop.id!==ctx.shop.id||current.shop.status!=='active'||!current.can('channels.configure_token'))return error(json,'forbidden',403);
 const items=pages.data;
 let count=0;
 for(const page of items){
  if(!/^\d+$/.test(String(page.id||''))||typeof page.access_token!=='string')continue;
  await saveAccount(db,env,who,ctx.shop.id,'facebook',page,page.access_token);count++;
  const ig=page.instagram_business_account;
  if(pages.canUseInstagram&&ig&&/^\d+$/.test(String(ig.id||''))){await saveAccount(db,env,who,ctx.shop.id,'instagram',{id:ig.id,name:ig.username||'Instagram'},page.access_token);count++;}
 }
 await audit(db,{shopId:ctx.shop.id,actor:who.owner,action:'social.meta_oauth_complete',detail:{accountCount:count}});
 const redirect=new URL('/',url.origin);redirect.searchParams.set('meta_connected',String(count));redirect.hash=messenger?'bot':'accounts';
 return new Response(null,{status:303,headers:{Location:redirect.toString(),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
}
