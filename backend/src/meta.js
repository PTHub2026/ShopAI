// Meta OAuth for Facebook Pages + linked Instagram Professional accounts.
// Never log authorization codes, OAuth access tokens or response bodies from Graph.
import {resolveShop,audit} from './shops.js';
import {encryptToken,decryptToken} from './social.js';
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
async function graphRequest(e,path,token,fields={},method='GET'){
 const uri=new URL(graph(e,path));
 let init={method,redirect:'manual',signal:AbortSignal.timeout(12000)};
 // Keep Graph access tokens out of URLs, browser history and edge request logs.
 init.headers={Authorization:'Bearer '+token};
 if(method==='GET'){uri.search=form(fields).toString();}
 else {init.headers['Content-Type']='application/x-www-form-urlencoded';init.body=form(fields).toString();}
 const r=await fetch(uri,init);const data=await r.json().catch(()=>({}));
 if(!r.ok||data.error){
  const err=Error('META_API_FAILED');err.status=r.status;err.code=data.error?.code;err.subcode=data.error?.error_subcode;
  const delay=Number(r.headers.get('Retry-After'));
  if(Number.isFinite(delay)&&delay>0)err.retryAfter=delay;
  throw err;
 }
 return data;
}
export async function publishMeta(e,account,job){
 const token=await decryptToken(e,account.token_ciphertext,account.token_iv);
 const p=JSON.parse(job.payload);
 if(account.provider==='facebook'){
  if(job.kind==='text'){
   const r=await graphRequest(e,encodeURIComponent(account.target_id)+'/feed',token,{message:p.text},'POST');
   if(!r.id)throw Error('META_MISSING_ID');return String(r.id);
  }
  const r=await graphRequest(e,encodeURIComponent(account.target_id)+'/photos',token,{url:p.photoUrl,caption:p.text},'POST');
  if(!r.post_id&&!r.id)throw Error('META_MISSING_ID');return String(r.post_id||r.id);
 }
 if(account.provider==='instagram'){
  if(job.kind!=='photo')throw Error('IG_REQUIRES_PHOTO');
  // Container creation is not publishing; once the publish call starts, network uncertainty is not retried.
  let container=job.id?await e.DB.prepare('SELECT container_id AS id FROM meta_publish_containers WHERE job_id=? AND shop_id=?').bind(job.id,job.shop_id).first():null;
  if(!container){
   container=await graphRequest(e,encodeURIComponent(account.target_id)+'/media',token,{image_url:p.photoUrl,caption:p.text},'POST');
   if(!container.id)throw Error('META_MISSING_CONTAINER');
   if(job.id)await e.DB.prepare('INSERT INTO meta_publish_containers(job_id,shop_id,container_id) VALUES(?,?,?)').bind(job.id,job.shop_id,String(container.id)).run();
  }
  // Instagram media creation can be asynchronous. Never publish an unready container.
  const status=await graphRequest(e,encodeURIComponent(String(container.id)),token,{fields:'status_code'});
  if(status.status_code!=='FINISHED'){
   if(status.status_code==='IN_PROGRESS'){
    const wait=Error('IG_MEDIA_PROCESSING');wait.status=429;wait.retryAfter=30;throw wait;
   }
   throw Error('IG_MEDIA_UNAVAILABLE');
  }
  let publish;
  try{publish=await graphRequest(e,encodeURIComponent(account.target_id)+'/media_publish',token,{creation_id:String(container.id)},'POST');}
  // A publish attempt must never become retryable, even if Graph sends Retry-After.
  catch(err){err.retryAfter=0;throw err;}
  if(!publish.id)throw Error('META_MISSING_ID');return String(publish.id);
 }
 throw Error('UNSUPPORTED_PROVIDER');
}
export function metaDenied(e){return e?.status===401||e?.code===190||e?.code===10||e?.code===200;}
async function saveAccount(db,env,who,shop,provider,item,token){
 const t=stamp(),secret=await encryptToken(env,token),id='sa_'+crypto.randomUUID();
 await db.prepare("INSERT INTO social_accounts(id,shop_id,provider,display_name,target_id,token_ciphertext,token_iv,status,connected_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'active',?,?,?) ON CONFLICT(shop_id,provider,target_id) DO UPDATE SET display_name=excluded.display_name,token_ciphertext=excluded.token_ciphertext,token_iv=excluded.token_iv,status='active',updated_at=excluded.updated_at")
 .bind(id,shop,provider,String(item.name||item.username||provider).slice(0,80),String(item.id),secret.cipher,secret.iv,who.owner,t,t).run();
 await audit(db,{shopId:shop,actor:who.owner,action:'social.connect',target:String(item.id),detail:{provider}});
}
const error=(json,code,status=400)=>json({error:code,code},status);
export async function handleMeta(req,env,who,json){
 if(!metaConfigured(env))return error(json,'meta_not_configured',503);
 if(!env.DB)return error(json,'db_missing',503);
 const url=new URL(req.url),segments=url.pathname.split('/'),act=segments.at(-1);
 if(!['start','callback'].includes(act))return error(json,'not_found',404);
 const db=env.DB;
 await db.batch(META_SCHEMA.map(s=>db.prepare(s)));
 await db.prepare('DELETE FROM meta_oauth_states WHERE expires_at<=?').bind(stamp()).run();
 let scopedRequest=req;
 if(act==='callback'){
  const state=url.searchParams.get('state');
  if(!state||!/^[-_A-Za-z0-9]{43}$/.test(state))return error(json,'invalid_oauth_state',400);
  const prior=await db.prepare('SELECT shop_id,actor FROM meta_oauth_states WHERE state_hash=?').bind(await sha(state)).first();
  if(!prior||prior.actor!==who.owner)return error(json,'invalid_oauth_state',403);
  const headers=new Headers(req.headers);headers.set('X-ShopPost-Shop',prior.shop_id);
  scopedRequest=new Request(req,{headers});
 }
 const ctx=await resolveShop(env,who,scopedRequest);
 if(ctx.error)return json({error:ctx.error,code:ctx.code},ctx.status);
 if(act==='start'){
  if(req.method!=='POST')return error(json,'method_not_allowed',405);
  if(!ctx.can('channels.configure_token')||ctx.shop.status!=='active')return error(json,'forbidden',403);
  const state=random(),t=stamp();
  await db.prepare('INSERT INTO meta_oauth_states(state_hash,shop_id,actor,expires_at,created_at) VALUES(?,?,?,?,?)').bind(await sha(state),ctx.shop.id,who.owner,t+600,t).run();
  const auth=new URL('https://www.facebook.com/'+version(env)+'/dialog/oauth');
  auth.search=new URLSearchParams({client_id:appId(env),redirect_uri:env.META_REDIRECT_URI,response_type:'code',state,scope:'pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish'}).toString();
  return json({authorizationUrl:auth.toString()});
 }
 if(req.method!=='GET')return error(json,'method_not_allowed',405);
 // Permissions may be removed while the user completes the OAuth consent screen.
 if(!ctx.can('channels.configure_token')||ctx.shop.status!=='active')return error(json,'forbidden',403);
 if(url.origin!==new URL(env.META_REDIRECT_URI).origin||url.pathname!==new URL(env.META_REDIRECT_URI).pathname)return error(json,'callback_origin_mismatch',400);
 const state=url.searchParams.get('state'),code=url.searchParams.get('code');
 if(!state||!/^[-_A-Za-z0-9]{43}$/.test(state))return error(json,'invalid_oauth_state',400);
 const hash=await sha(state);
 const row=await db.prepare('SELECT shop_id,actor,expires_at FROM meta_oauth_states WHERE state_hash=?').bind(hash).first();
 if(!row||row.actor!==who.owner||row.shop_id!==ctx.shop.id||row.expires_at<=stamp())return error(json,'invalid_or_expired_state',403);
 // Atomic consume before any outbound token exchange: callback replay is denied.
 const consumed=await db.prepare('DELETE FROM meta_oauth_states WHERE state_hash=? AND shop_id=? AND actor=? AND expires_at>?').bind(hash,ctx.shop.id,who.owner,stamp()).run();
 if(consumed.meta.changes!==1)return error(json,'oauth_state_used',403);
 if(!code||code.length>2048)return error(json,'oauth_declined',400);
 let pages;
 try {
  const tokenUrl=new URL(graph(env,'oauth/access_token'));
  tokenUrl.search=new URLSearchParams({client_id:appId(env),client_secret:appSecret(env),redirect_uri:env.META_REDIRECT_URI,code}).toString();
  const tokenResp=await fetch(tokenUrl,{redirect:'manual',signal:AbortSignal.timeout(12000)});
  const tokenData=await tokenResp.json().catch(()=>({}));
  if(!tokenResp.ok||typeof tokenData.access_token!=='string')throw Error('META_TOKEN_FAILED');
  // Exchange short-lived token before deriving page tokens.
  const longUrl=new URL(graph(env,'oauth/access_token'));
  longUrl.search=new URLSearchParams({grant_type:'fb_exchange_token',client_id:appId(env),client_secret:appSecret(env),fb_exchange_token:tokenData.access_token}).toString();
  const longResp=await fetch(longUrl,{redirect:'manual',signal:AbortSignal.timeout(12000)});
  const long=await longResp.json().catch(()=>({}));
  if(!longResp.ok||typeof long.access_token!=='string')throw Error('META_LONG_TOKEN_FAILED');
  const permissions=await graphRequest(env,'me/permissions',long.access_token,{limit:'100'});
  const granted=new Set((Array.isArray(permissions.data)?permissions.data:[]).filter(p=>p.status==='granted').map(p=>p.permission));
  if(!granted.has('pages_show_list')||!granted.has('pages_manage_posts'))throw Error('META_PAGE_SCOPE_DENIED');
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
 }catch{return error(json,'meta_authorization_failed',502);}
 const items=pages.data;
 let count=0;
 for(const page of items){
  if(!/^\d+$/.test(String(page.id||''))||typeof page.access_token!=='string')continue;
  await saveAccount(db,env,who,ctx.shop.id,'facebook',page,page.access_token);count++;
  const ig=page.instagram_business_account;
  if(pages.canUseInstagram&&ig&&/^\d+$/.test(String(ig.id||''))){await saveAccount(db,env,who,ctx.shop.id,'instagram',{id:ig.id,name:ig.username||'Instagram'},page.access_token);count++;}
 }
 await audit(db,{shopId:ctx.shop.id,actor:who.owner,action:'social.meta_oauth_complete',detail:{accountCount:count}});
 const redirect=new URL('/',url.origin);redirect.searchParams.set('meta_connected',String(count));redirect.hash='accounts';
 return new Response(null,{status:303,headers:{Location:redirect.toString(),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
}
