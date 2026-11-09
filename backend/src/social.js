import {resolveShop,audit,writeLimit} from './shops.js';
import {handleMeta,publishMeta,metaDenied,metaConfigured} from './meta.js';
const now=()=>Math.floor(Date.now()/1000);
export const SOCIAL_SCHEMA=["CREATE TABLE IF NOT EXISTS social_accounts (id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('telegram','facebook','instagram')), display_name TEXT NOT NULL, target_id TEXT NOT NULL, token_ciphertext TEXT NOT NULL, token_iv TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked','error')), connected_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(shop_id,provider,target_id));","CREATE INDEX IF NOT EXISTS social_accounts_shop ON social_accounts(shop_id,status);","CREATE TABLE IF NOT EXISTS publish_jobs (id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, account_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('text','photo')), payload TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','retryable','unknown','failed')), attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, remote_message_id TEXT, error_code TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(shop_id,idempotency_key));","CREATE INDEX IF NOT EXISTS publish_jobs_shop ON publish_jobs(shop_id,created_at DESC);"];
const initialized=new WeakSet();
export async function ensureSocialSchema(db){if(initialized.has(db))return;await db.batch(SOCIAL_SCHEMA.map(s=>db.prepare(s)));initialized.add(db);}
function decodeKey(env){if(typeof env.SOCIAL_TOKEN_KEY!=='string')throw Error('KEY_MISSING');let x=Uint8Array.from(atob(env.SOCIAL_TOKEN_KEY),c=>c.charCodeAt(0));if(x.length!==32)throw Error('KEY_INVALID');return x;}
const b64=x=>btoa(String.fromCharCode(...x)),un64=x=>Uint8Array.from(atob(x),c=>c.charCodeAt(0));
async function key(env){return crypto.subtle.importKey('raw',decodeKey(env),'AES-GCM',false,['encrypt','decrypt']);}
export async function encryptToken(env,token){const iv=crypto.getRandomValues(new Uint8Array(12));const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await key(env),new TextEncoder().encode(token)));return {cipher:b64(cipher),iv:b64(iv)};}
export async function decryptToken(env,cipher,iv){return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:un64(iv)},await key(env),un64(cipher)));}
async function callTelegram(token,method,body){
 const r=await fetch('https://api.telegram.org/bot'+token+'/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(12000)});
 const data=await r.json().catch(()=>({}));
 if(!r.ok||data.ok!==true){const e=Error('TELEGRAM_FAILED');e.status=r.status;e.retryAfter=Number(data.parameters?.retry_after)||0;throw e;}
 return data.result;
}
async function input(req){if(!(req.headers.get('content-type')||'').startsWith('application/json'))return null;const s=await req.text();if(s.length>8192)return null;try{const j=JSON.parse(s);return j&&typeof j==='object'&&!Array.isArray(j)?j:null;}catch{return null;}}
const view=a=>({id:a.id,name:a.display_name,provider:a.provider,targetId:a.target_id,status:a.status});
const jobView=j=>({id:j.id,accountId:j.account_id,status:j.status,kind:j.kind,attempts:j.attempts,remoteMessageId:j.remote_message_id,errorCode:j.error_code});
const fail=(json,status,code)=>json({error:code,code},status);
export async function handleSocial(req,env,who,json){
 if(!env.DB)return fail(json,503,'db_missing');
 if(req.method!=='GET'&&req.method!=='HEAD'){
  if(req.headers.get('Origin')!==new URL(req.url).origin)return fail(json,403,'forbidden');
  const limited=await writeLimit(env,who.owner);
  if(limited)return json({error:limited.error},limited.status,limited.status===429?{'Retry-After':'60'}:{});
 }
 try{decodeKey(env);}catch{return fail(json,503,'social_key_missing');}
 const [,,,section,resource,action]=new URL(req.url).pathname.split('/');
 if(section==='providers'&&!resource&&req.method==='GET'){
  const ctx=await resolveShop(env,who,req);if(ctx.error)return json({error:ctx.error,code:ctx.code},ctx.status);
  if(!ctx.can('channels.view'))return fail(json,403,'forbidden');
  return json({telegram:{enabled:true},facebook:{enabled:metaConfigured(env)},instagram:{enabled:metaConfigured(env)}});
 }
 if(section==='meta') { await ensureSocialSchema(env.DB); return handleMeta(req,env,who,json); }
 const ctx=await resolveShop(env,who,req);if(ctx.error)return json({error:ctx.error,code:ctx.code},ctx.status);
 const db=env.DB,shop=ctx.shop.id;await ensureSocialSchema(db);
 if(section==='accounts'&&!resource&&req.method==='GET'){
  if(!ctx.can('channels.view'))return fail(json,403,'forbidden');
  const {results}=await db.prepare('SELECT id,display_name,provider,target_id,status FROM social_accounts WHERE shop_id=? ORDER BY created_at DESC').bind(shop).all();return json({accounts:results.map(view)});
 }
 if(section==='accounts'&&!resource&&req.method==='POST'){
  if(!ctx.can('channels.configure_token')||ctx.shop.status!=='active')return fail(json,403,'forbidden');
  const data=await input(req),token=data?.token,chat=data?.chatId;
  if(typeof token!=='string'||!/^\d{6,15}:[\w-]{25,80}$/.test(token)||typeof chat!=='string'||!/^(-?\d{5,22}|@[\w]{5,32})$/.test(chat))return fail(json,400,'invalid_input');
  let bot,target;try{bot=await callTelegram(token,'getMe',{});target=await callTelegram(token,'getChat',{chat_id:chat});}catch{return fail(json,422,'telegram_verification_failed');}
  if(!bot?.is_bot||!target?.id)return fail(json,422,'telegram_verification_failed');
  const encrypted=await encryptToken(env,token),t=now(),id='sa_'+crypto.randomUUID(),targetId=String(target.id);
  await db.prepare("INSERT INTO social_accounts(id,shop_id,provider,display_name,target_id,token_ciphertext,token_iv,status,connected_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'active',?,?,?) ON CONFLICT(shop_id,provider,target_id) DO UPDATE SET token_ciphertext=excluded.token_ciphertext,token_iv=excluded.token_iv,status='active',updated_at=excluded.updated_at")
   .bind(id,shop,'telegram',String(target.title||target.username||bot.username||'Telegram').slice(0,80),targetId,encrypted.cipher,encrypted.iv,who.owner,t,t).run();
  await audit(db,{shopId:shop,actor:who.owner,action:'social.connect',target:targetId,detail:{provider:'telegram'}});
  return json({ok:true,targetId},201);
 }
 if(section==='accounts'&&resource&&!action&&req.method==='DELETE'){
  if(!ctx.can('channels.configure_token'))return fail(json,403,'forbidden');
  const r=await db.prepare("UPDATE social_accounts SET status='revoked',token_ciphertext='',token_iv='',updated_at=? WHERE id=? AND shop_id=?").bind(now(),resource,shop).run();
  if(r.meta.changes!==1)return fail(json,404,'not_found');return json({ok:true});
 }
 if(section==='jobs'&&!resource&&req.method==='GET'){
  if(!ctx.can('channels.view'))return fail(json,403,'forbidden');
  const {results}=await db.prepare('SELECT id,account_id,status,kind,attempts,remote_message_id,error_code FROM publish_jobs WHERE shop_id=? ORDER BY created_at DESC LIMIT 50').bind(shop).all();return json({jobs:results.map(jobView)});
 }
 if(section==='jobs'&&!resource&&req.method==='POST'){
  if(!ctx.can('channels.operate')&&!ctx.can('drafts.publish'))return fail(json,403,'forbidden');
  if(ctx.shop.status!=='active')return fail(json,403,'shop_suspended');
  const data=await input(req),idem=req.headers.get('Idempotency-Key')||data?.idempotencyKey;
  if(typeof idem!=='string'||!/^[\w-]{12,100}$/.test(idem)||typeof data?.accountId!=='string'||!['text','photo'].includes(data.kind)||typeof data.text!=='string'||data.text.length>(data.kind==='photo'?1024:4096)||(!data.text.trim()&&data.kind==='text'))return fail(json,400,'invalid_input');
  if(data.kind==='photo'&&(typeof data.photoUrl!=='string'||!/^https:\/\/[^\s@/]+(?:\/[^\s]*)?$/.test(data.photoUrl)||data.photoUrl.length>2048))return fail(json,400,'invalid_photo');
  const a=await db.prepare("SELECT id,provider FROM social_accounts WHERE shop_id=? AND id=? AND status='active'").bind(shop,data.accountId).first();if(!a)return fail(json,404,'account_missing');
  if(a.provider==='instagram'&&data.kind!=='photo')return fail(json,400,'instagram_requires_photo');
  const payload=JSON.stringify({text:data.text,photoUrl:data.kind==='photo'?data.photoUrl:null}),t=now();
  await db.prepare("INSERT OR IGNORE INTO publish_jobs(id,shop_id,account_id,idempotency_key,kind,payload,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,'pending',?,?,?)").bind('pj_'+crypto.randomUUID(),shop,a.id,idem,data.kind,payload,who.owner,t,t).run();
  const j=await db.prepare('SELECT * FROM publish_jobs WHERE shop_id=? AND idempotency_key=?').bind(shop,idem).first();
  if(j.account_id!==a.id||j.kind!==data.kind||j.payload!==payload)return fail(json,409,'idempotency_conflict');
  return deliver(j,db,env,shop,json,who.owner);
 }
 if(section==='jobs'&&resource&&action==='retry'&&req.method==='POST'){
  if(!ctx.can('channels.operate')&&!ctx.can('drafts.publish'))return fail(json,403,'forbidden');
  if(ctx.shop.status!=='active')return fail(json,403,'shop_suspended');
  const j=await db.prepare('SELECT * FROM publish_jobs WHERE shop_id=? AND id=?').bind(shop,resource).first();
  if(!j)return fail(json,404,'not_found');return deliver(j,db,env,shop,json,who.owner);
 }
 return fail(json,404,'not_found');
}
async function deliver(j,db,env,shop,json,actor){
 if(j.status==='retryable'&&j.next_attempt_at>now())return json({job:jobView(j),retryAfter:j.next_attempt_at-now()},429);
 if(!['pending','retryable'].includes(j.status))return json({job:jobView(j)},j.status==='sent'?200:409);
 const c=await db.prepare("UPDATE publish_jobs SET status='sending',attempts=attempts+1,updated_at=? WHERE shop_id=? AND id=? AND status IN ('pending','retryable') AND next_attempt_at<=?").bind(now(),shop,j.id,now()).run();
 if(c.meta.changes!==1)return fail(json,409,'in_progress');
 const a=await db.prepare("SELECT * FROM social_accounts WHERE shop_id=? AND id=? AND status='active'").bind(shop,j.account_id).first();
 if(!a){await db.prepare("UPDATE publish_jobs SET status='failed',error_code='account_revoked' WHERE id=?").bind(j.id).run();return fail(json,409,'account_revoked');}
 let status='unknown',error='delivery_uncertain',remote=null,nextAttempt=0;
 try{const token=await decryptToken(env,a.token_ciphertext,a.token_iv),p=JSON.parse(j.payload);
  if(a.provider==='telegram'){
   const result=j.kind==='text'?await callTelegram(token,'sendMessage',{chat_id:a.target_id,text:p.text}):await callTelegram(token,'sendPhoto',{chat_id:a.target_id,photo:p.photoUrl,caption:p.text});
   if(!Number.isSafeInteger(result?.message_id)||result.message_id<=0)throw Error('TELEGRAM_MISSING_MESSAGE_ID');
   remote=String(result.message_id);
  }else { remote=await publishMeta(env,a,j); }
  status='sent';error=null;
 }catch(e){const retryAt=now()+Math.ceil(e.retryAfter);if(e.status===429&&Number.isFinite(e.retryAfter)&&e.retryAfter>0&&Number.isSafeInteger(retryAt)){status='retryable';error='rate_limited';nextAttempt=retryAt; }else if(e.status===401||e.status===403||metaDenied(e)){status='failed';error='provider_denied';await db.prepare("UPDATE social_accounts SET status='error' WHERE id=? AND shop_id=?").bind(a.id,shop).run();}}
 await db.prepare('UPDATE publish_jobs SET status=?,remote_message_id=?,error_code=?,updated_at=?,next_attempt_at=? WHERE id=? AND shop_id=?').bind(status,remote,error,now(),nextAttempt,j.id,shop).run();
 await audit(db,{shopId:shop,actor,action:'social.publish',target:j.id,detail:{status,error}});
 return json({job:{...jobView(j),status,attempts:j.attempts+1,remoteMessageId:remote,errorCode:error}},status==='sent'?200:status==='retryable'?429:502);
}
