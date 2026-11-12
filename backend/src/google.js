// YouTube channel authorization is separate from Shoppost account sign-in.
// No Google identity, Gmail or Drive access is requested.
import {resolveShop,audit} from './shops.js';
import {encryptToken,decryptToken} from './social.js';
export const GOOGLE_SCOPES='https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload';
export const GOOGLE_SCHEMA=[
 `CREATE TABLE IF NOT EXISTS google_oauth_states(state_hash TEXT PRIMARY KEY,shop_id TEXT NOT NULL,actor TEXT NOT NULL,verifier TEXT NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending')`,
 `CREATE TABLE IF NOT EXISTS google_channels(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL,external_id TEXT NOT NULL,name TEXT NOT NULL,credential TEXT NOT NULL,credential_iv TEXT NOT NULL,status TEXT NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(shop_id,external_id))`,
 `CREATE INDEX IF NOT EXISTS google_channels_shop ON google_channels(shop_id,status)`,
 `CREATE TABLE IF NOT EXISTS google_uploads(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL,account_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,fingerprint TEXT NOT NULL,status TEXT NOT NULL,video_id TEXT,error_code TEXT,created_at INTEGER NOT NULL,UNIQUE(shop_id,idempotency_key))`
];
const now=()=>Math.floor(Date.now()/1000);
const base64url=b=>btoa(String.fromCharCode(...b)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const random=()=>base64url(crypto.getRandomValues(new Uint8Array(32)));
const digest=async s=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));
const hash=async s=>base64url(await digest(s));
const fail=(json,code,status=400)=>json({error:code,code},status);
export function googleConfigured(env){
 try{return typeof env.GOOGLE_CLIENT_ID==='string'&&/^[\w.-]+\.apps\.googleusercontent\.com$/.test(env.GOOGLE_CLIENT_ID)&&Boolean(env.GOOGLE_CLIENT_SECRET)&&Boolean(env.SOCIAL_TOKEN_KEY)&&/^https:\/\/[^/?#]+\/api\/social\/google\/callback$/.test(env.GOOGLE_REDIRECT_URI||'');}catch{return false;}
}
async function googleFetch(url,init){
 const response=await fetch(url,{...init,redirect:'manual',signal:AbortSignal.timeout(20000)});
 const data=await response.json().catch(()=>({}));
 if(!response.ok||data.error)throw Object.assign(Error('google_request_failed'),{status:response.status,reauth:response.status===401||data.error==='invalid_grant'});
 return data;
}
const tokenRequest=(env,fields)=>googleFetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,...fields}).toString()});
const channelInventory=token=>googleFetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&maxResults=50',{headers:{Authorization:'Bearer '+token}});
export async function cleanupGoogleData(env){
 if(!env.DB)return;
 const db=env.DB,t=now();
 await db.batch(GOOGLE_SCHEMA.map(s=>db.prepare(s)));
 await db.batch([
  db.prepare('DELETE FROM google_oauth_states WHERE expires_at<=?').bind(t),
  db.prepare('DELETE FROM google_channels WHERE updated_at<=?').bind(t-30*86400),
  db.prepare('DELETE FROM google_uploads WHERE created_at<=?').bind(t-30*86400)
 ]);
}

export async function handleGoogle(req,env,who,json){
 if(!env.DB)return fail(json,'db_missing',503);
 const db=env.DB,url=new URL(req.url),action=url.pathname.slice('/api/social/google/'.length);
 if(!['accounts','start','callback'].includes(action)&&!action.startsWith('accounts/')&&!['upload','uploads','video-stats'].includes(action))return fail(json,'not_found',404);
 await db.batch(GOOGLE_SCHEMA.map(s=>db.prepare(s)));
 await cleanupGoogleData(env);
 let scoped=req,stateHash=null,stateRow=null;
 if(action==='callback'){
  if(req.method!=='GET')return fail(json,'method_not_allowed',405);
  const state=url.searchParams.get('state');
  if(!/^[\w-]{43}$/.test(state||''))return fail(json,'invalid_oauth_state',403);
  stateHash=await hash(state);
  stateRow=await db.prepare('SELECT * FROM google_oauth_states WHERE state_hash=? AND expires_at>?').bind(stateHash,now()).first();
  if(!stateRow||stateRow.actor!==who.owner||stateRow.status!=='pending')return fail(json,'invalid_oauth_state',403);
  const headers=new Headers(req.headers);headers.set('X-ShopPost-Shop',stateRow.shop_id);scoped=new Request(req,{headers});
 }
 let ctx=await resolveShop(env,who,scoped);
 if(ctx.error)return json({error:ctx.error,code:ctx.code},ctx.status);
 const shop=ctx.shop.id;
 if(action==='accounts'&&req.method==='GET'){
  if(!ctx.can('channels.view'))return fail(json,'forbidden',403);
  const {results}=await db.prepare('SELECT id,external_id,name,status FROM google_channels WHERE shop_id=? ORDER BY updated_at DESC').bind(shop).all();
  return json({configured:googleConfigured(env),accounts:results.map(a=>({id:a.id,targetId:a.external_id,name:a.name,provider:'youtube',status:a.status})),capabilities:{videoUpload:true,maxUploadBytes:50*1024*1024}});
 }
 if(action==='uploads'&&req.method==='GET'){
  if(!ctx.can('channels.view'))return fail(json,'forbidden',403);
  const {results}=await db.prepare('SELECT id,status,video_id,error_code,created_at FROM google_uploads WHERE shop_id=? ORDER BY created_at DESC LIMIT 50').bind(shop).all();
  return json({uploads:results.map(r=>({id:r.id,status:r.status,videoId:r.video_id,errorCode:r.error_code,createdAt:r.created_at}))});
 }
 if(action.startsWith('accounts/')&&req.method==='DELETE'){
  if(!ctx.can('channels.configure_token'))return fail(json,'forbidden',403);
  const id=action.slice('accounts/'.length);
  const row=await db.prepare('SELECT id FROM google_channels WHERE id=? AND shop_id=?').bind(id,shop).first();
  if(!row)return fail(json,'not_found',404);
  await db.batch([
   db.prepare("UPDATE google_channels SET credential='',credential_iv='',status='revoked',updated_at=? WHERE id=? AND shop_id=?").bind(now(),id,shop),
   db.prepare('DELETE FROM google_oauth_states WHERE shop_id=?').bind(shop)
  ]);
  await audit(db,{shopId:shop,actor:who.owner,action:'google.disconnect',target:id});return json({ok:true});
 }
 if(!googleConfigured(env))return fail(json,'google_not_configured',503);
 if(action==='video-stats'&&req.method==='GET')return videoStats(req,env,who,json,ctx,url);
 if(action==='upload'&&req.method==='POST')return uploadVideo(req,env,who,json,ctx);
 if(action==='start'&&req.method==='POST'){
  if(!ctx.can('channels.configure_token')||ctx.shop.status!=='active')return fail(json,'forbidden',403);
  const state=random(),verifier=random(),t=now();
  await db.batch([db.prepare('DELETE FROM google_oauth_states WHERE expires_at<=?').bind(t),db.prepare('INSERT INTO google_oauth_states(state_hash,shop_id,actor,verifier,expires_at) VALUES(?,?,?,?,?)').bind(await hash(state),shop,who.owner,verifier,t+600)]);
  const auth=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search=new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,redirect_uri:env.GOOGLE_REDIRECT_URI,response_type:'code',scope:GOOGLE_SCOPES,access_type:'offline',prompt:'consent',state,code_challenge:await hash(verifier),code_challenge_method:'S256'}).toString();
  return json({authorizationUrl:auth.toString()});
 }
 if(action==='callback'){
  if(!ctx.can('channels.configure_token')||ctx.shop.status!=='active')return fail(json,'forbidden',403);
  if(url.origin+url.pathname!==env.GOOGLE_REDIRECT_URI)return fail(json,'callback_origin_mismatch',400);
  const claimed=await db.prepare("UPDATE google_oauth_states SET status='exchanging' WHERE state_hash=? AND status='pending' AND expires_at>?").bind(stateHash,now()).run();
  if(claimed.meta.changes!==1)return fail(json,'oauth_state_used',403);
  const code=url.searchParams.get('code');
  if(url.searchParams.has('error')||!code||code.length>4096){await db.prepare('DELETE FROM google_oauth_states WHERE state_hash=?').bind(stateHash).run();return fail(json,'google_authorization_declined');}
  let token,channel;
  try{
   token=await tokenRequest(env,{grant_type:'authorization_code',redirect_uri:env.GOOGLE_REDIRECT_URI,code,code_verifier:stateRow.verifier});
   const granted=new Set(String(token.scope||'').split(' '));
   if(typeof token.access_token!=='string'||typeof token.refresh_token!=='string'||!token.refresh_token||!GOOGLE_SCOPES.split(' ').every(s=>granted.has(s))||!(Number(token.expires_in)>0))throw Error('google_incomplete_grant');
   const inventory=await channelInventory(token.access_token);
   if(!Array.isArray(inventory.items)||inventory.items.length!==1||inventory.nextPageToken)throw Error('google_channel_ambiguous');
   channel=inventory.items[0];
   if(!/^UC[\w-]{22}$/.test(channel.id||''))throw Error('google_channel_missing');
  }catch{
   await db.prepare('DELETE FROM google_oauth_states WHERE state_hash=?').bind(stateHash).run();
   return fail(json,'google_authorization_failed',422);
  }
  // Re-check membership after provider I/O; disconnect can also invalidate the state.
  ctx=await resolveShop(env,who,scoped);
  if(ctx.error||!ctx.can('channels.configure_token')||ctx.shop.status!=='active')return fail(json,'forbidden',403);
  const secret=await encryptToken(env,JSON.stringify({accessToken:token.access_token,refreshToken:token.refresh_token,expiresAt:now()+Math.min(Number(token.expires_in),86400)}));
  const results=await db.batch([
   db.prepare(`INSERT INTO google_channels(id,shop_id,external_id,name,credential,credential_iv,status,updated_at)
    SELECT ?,?,?,?,?,?,'connected',? WHERE EXISTS(SELECT 1 FROM google_oauth_states WHERE state_hash=? AND shop_id=? AND actor=? AND status='exchanging' AND expires_at>?)
    ON CONFLICT(shop_id,external_id) DO UPDATE SET name=excluded.name,credential=excluded.credential,credential_iv=excluded.credential_iv,status='connected',updated_at=excluded.updated_at`)
    .bind('yt_'+crypto.randomUUID(),shop,channel.id,String(channel.snippet?.title||'YouTube').slice(0,100),secret.cipher,secret.iv,now(),stateHash,shop,who.owner,now()),
   db.prepare('DELETE FROM google_oauth_states WHERE state_hash=?').bind(stateHash)
  ]);
  if(results[0].meta.changes!==1)return fail(json,'oauth_state_used',403);
  await audit(db,{shopId:shop,actor:who.owner,action:'google.connect',target:'youtube-channel'});
  return new Response(null,{status:303,headers:{Location:url.origin+'/?google_connected=1#accounts','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
 }
 return fail(json,'method_not_allowed',405);
}

export async function googleAccessToken(env,account){
 let token=JSON.parse(await decryptToken(env,account.credential,account.credential_iv));
 if(token.expiresAt>now()+90)return token.accessToken;
 const fresh=await tokenRequest(env,{grant_type:'refresh_token',refresh_token:token.refreshToken});
 if(typeof fresh.access_token!=='string'||!(Number(fresh.expires_in)>0))throw Error('google_token_refresh_failed');
 token={...token,accessToken:fresh.access_token,expiresAt:now()+Math.min(Number(fresh.expires_in),86400)};
 const encrypted=await encryptToken(env,JSON.stringify(token));
 const saved=await env.DB.prepare("UPDATE google_channels SET credential=?,credential_iv=?,updated_at=? WHERE id=? AND shop_id=? AND status='connected' AND credential=?")
  .bind(encrypted.cipher,encrypted.iv,now(),account.id,account.shop_id,account.credential).run();
 if(saved.meta.changes!==1)throw Error('google_connection_changed');
 return token.accessToken;
}

// Snapshot counters from YouTube. Unavailable counters remain null, including hidden likes or comments.
async function videoStats(req,env,who,json,ctx,url){
 if(!ctx.can('reports.view'))return fail(json,'forbidden',403);
 const db=env.DB,shop=ctx.shop.id,accountId=url.searchParams.get('accountId');
 const account=await db.prepare("SELECT * FROM google_channels WHERE id=? AND shop_id=? AND status='connected'").bind(accountId,shop).first();
 if(!account)return fail(json,'account_missing',404);
 const videoId=/^[\w-]{11}$/;
 const count=value=>typeof value==='string'&&/^\d{1,20}$/.test(value)?value:null;
 let videos=[];
 try{
  const access=await googleAccessToken(env,account);
  const get=(path,parameters)=>googleFetch('https://www.googleapis.com/youtube/v3/'+path+'?'+new URLSearchParams(parameters),{headers:{Authorization:'Bearer '+access}});
  const channels=await get('channels',{part:'contentDetails',mine:'true',maxResults:'50'});
  const playlist=channels.items?.find(item=>item.id===account.external_id)?.contentDetails?.relatedPlaylists?.uploads;
  if(typeof playlist!=='string'||!/^[-\w]{1,128}$/.test(playlist))return fail(json,'youtube_channel_unavailable',422);
  const items=await get('playlistItems',{part:'contentDetails',playlistId:playlist,maxResults:'25'});
  if(!Array.isArray(items.items))return fail(json,'youtube_stats_unavailable',502);
  const ids=[...new Set(items.items.map(item=>item.contentDetails?.videoId).filter(id=>typeof id==='string'&&videoId.test(id)))].slice(0,25);
  if(ids.length){
   const result=await get('videos',{part:'snippet,statistics',id:ids.join(',')});
   if(!Array.isArray(result.items))return fail(json,'youtube_stats_unavailable',502);
   const byId=new Map(result.items.filter(v=>v.snippet?.channelId===account.external_id).map(v=>[v.id,v]));
   videos=ids.map(id=>{
    const video=byId.get(id);
    if(!video)return {id,title:null,views:null,likes:null,comments:null};
    return {id,title:typeof video.snippet.title==='string'?video.snippet.title.slice(0,150):null,views:count(video.statistics?.viewCount),likes:count(video.statistics?.likeCount),comments:count(video.statistics?.commentCount)};
   });
  }
 }catch(error){
  if(error.reauth)return fail(json,'google_reauth_required',409);
  if(error.status===429)return fail(json,'youtube_stats_rate_limited',429);
  return fail(json,'youtube_stats_unavailable',502);
 }
 const current=await resolveShop(env,who,req);
 if(current.error||current.shop.id!==shop||!current.can('reports.view'))return fail(json,'forbidden',403);
 const stillConnected=await db.prepare("SELECT id FROM google_channels WHERE id=? AND shop_id=? AND status='connected'").bind(account.id,shop).first();
 if(!stillConnected)return fail(json,'account_missing',404);
 return json({videos,fetchedAt:now()},200,{'Cache-Control':'no-store'});
}

async function uploadVideo(req,env,who,json,ctx){
 if((!ctx.can('channels.operate')&&!ctx.can('drafts.publish'))||ctx.shop.status!=='active')return fail(json,'forbidden',403);
 const url=new URL(req.url),shop=ctx.shop.id,db=env.DB;
 const idempotency=req.headers.get('Idempotency-Key'),accountId=url.searchParams.get('accountId');
 const title=url.searchParams.get('title')?.trim(),description=url.searchParams.get('description')||'',privacy=url.searchParams.get('privacy'),kids=url.searchParams.get('madeForKids');
 const mime=req.headers.get('Content-Type')?.split(';')[0],length=Number(req.headers.get('Content-Length'));
 if(!/^[\w-]{12,100}$/.test(idempotency||'')||!title||title.length>100||/[<>]/.test(title)||description.length>5000||/[<>]/.test(description)||!['public','private','unlisted'].includes(privacy)||!['true','false'].includes(kids))return fail(json,'invalid_video_metadata');
 if(!['video/mp4','video/webm','video/quicktime'].includes(mime)||!Number.isSafeInteger(length)||length<1||length>50*1024*1024||!req.body)return fail(json,'invalid_video_file',413);
 const account=await db.prepare("SELECT * FROM google_channels WHERE id=? AND shop_id=? AND status='connected'").bind(accountId,shop).first();
 if(!account)return fail(json,'account_missing',404);
 const fingerprint=await hash(JSON.stringify({accountId,title,description,privacy,kids,mime,length}));
 const claimed=await db.prepare("INSERT OR IGNORE INTO google_uploads(id,shop_id,account_id,idempotency_key,fingerprint,status,created_at) VALUES(?,?,?,?,?,'processing',?)").bind('yu_'+crypto.randomUUID(),shop,accountId,idempotency,fingerprint,now()).run();
 const job=await db.prepare('SELECT * FROM google_uploads WHERE shop_id=? AND idempotency_key=?').bind(shop,idempotency).first();
 if(job.fingerprint!==fingerprint)return fail(json,'idempotency_conflict',409);
 if(claimed.meta.changes!==1)return json({ok:job.status==='sent',status:job.status,videoId:job.video_id,id:job.id,error:job.error_code||undefined},job.status==='sent'?200:409);
 let started=false;
 try{
  const token=await googleAccessToken(env,account);
  // Confirm the grant still refers to the immutable channel, including after refresh.
  const inventory=await channelInventory(token);
  if(inventory.items?.length!==1||inventory.items[0].id!==account.external_id)throw Error('google_channel_changed');
  const freshCtx=await resolveShop(env,who,req);
  const active=await db.prepare("SELECT id,credential FROM google_channels WHERE id=? AND shop_id=? AND status='connected'").bind(accountId,shop).first();
  if(!active||freshCtx.error||(!freshCtx.can('channels.operate')&&!freshCtx.can('drafts.publish'))||freshCtx.shop.status!=='active')throw Error('google_connection_changed');
  const init=await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=false',{
   method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json; charset=UTF-8','X-Upload-Content-Length':String(length),'X-Upload-Content-Type':mime},
   body:JSON.stringify({snippet:{title,description},status:{privacyStatus:privacy,selfDeclaredMadeForKids:kids==='true'}}),redirect:'manual',signal:AbortSignal.timeout(20000)
  });
  if(!init.ok)throw Object.assign(Error('youtube_upload_rejected'),{status:init.status});
  const location=new URL(init.headers.get('location')||'');
  if(location.origin!=='https://www.googleapis.com'||location.pathname!=='/upload/youtube/v3/videos'||location.username||location.password||location.hash)throw Error('youtube_invalid_upload_session');
  const current=await db.prepare("SELECT credential FROM google_channels WHERE id=? AND shop_id=? AND status='connected'").bind(accountId,shop).first();
  const currentCtx=await resolveShop(env,who,req);
  if(!current||current.credential!==active.credential||currentCtx.error||currentCtx.shop.status!=='active'||(!currentCtx.can('channels.operate')&&!currentCtx.can('drafts.publish')))throw Error('google_connection_changed');
  // Forward a bounded stream; never buffer video in Worker memory or follow redirects with credentials.
  let bytes=0;
  // workerd derives Content-Length from FixedLengthStream, ignoring a manually set header.
  // Standard runtimes use the equivalent bounded TransformStream.
  const limiter=typeof FixedLengthStream==='function'?new FixedLengthStream(length):new TransformStream({transform(chunk,controller){bytes+=chunk.byteLength;if(bytes>length)throw Error('video_size_mismatch');controller.enqueue(chunk);},flush(){if(bytes!==length)throw Error('video_size_mismatch');}});
  const body=req.body.pipeThrough(limiter);
  started=true;
  const uploaded=await fetch(location.toString(),{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':mime,'Content-Length':String(length)},body,duplex:'half',redirect:'manual',signal:AbortSignal.timeout(55000)});
  const result=await uploaded.json().catch(()=>({}));
  if(!uploaded.ok||!/^[-\w]{11}$/.test(result.id||''))throw Error('youtube_delivery_unconfirmed');
  await db.prepare("UPDATE google_uploads SET status='sent',video_id=? WHERE id=? AND shop_id=?").bind(result.id,job.id,shop).run();
  await audit(db,{shopId:shop,actor:who.owner,action:'youtube.upload',target:job.id,detail:{status:'sent'}});
  return json({ok:true,id:job.id,status:'sent',videoId:result.id,url:'https://www.youtube.com/watch?v='+result.id});
 }catch(e){
  const status=started?'unknown':'failed',code=started?'youtube_delivery_uncertain':'youtube_upload_failed';
  await db.prepare('UPDATE google_uploads SET status=?,error_code=? WHERE id=? AND shop_id=?').bind(status,code,job.id,shop).run();
  if(e.reauth)await db.prepare("UPDATE google_channels SET status='reauth_required' WHERE id=? AND shop_id=? AND credential=?").bind(accountId,shop,account.credential).run();
  await audit(db,{shopId:shop,actor:who.owner,action:'youtube.upload',target:job.id,detail:{status}});
  return json({ok:false,id:job.id,status,error:code,code},502);
 }
}
