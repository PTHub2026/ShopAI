import {channels as handleChannels} from './channels.js';
import {ensureChannelStore} from './channel-store.js';
import {validatePost, retryDecision, publishFor} from './provider-adapters.js';
import {resolveShop,audit} from './shops.js';
import {handleMeta,publishMeta,metaDenied,metaConfigured} from './meta.js';
const now=()=>Math.floor(Date.now()/1000);
export const SOCIAL_SCHEMA=["CREATE TABLE IF NOT EXISTS social_accounts (id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('telegram','facebook','instagram')), display_name TEXT NOT NULL, target_id TEXT NOT NULL, token_ciphertext TEXT NOT NULL, token_iv TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked','error')), connected_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(shop_id,provider,target_id));","CREATE INDEX IF NOT EXISTS social_accounts_shop ON social_accounts(shop_id,status);","CREATE TABLE IF NOT EXISTS publish_jobs (id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, account_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('text','photo')), payload TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','retryable','unknown','failed')), attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, remote_message_id TEXT, error_code TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(shop_id,idempotency_key));","CREATE INDEX IF NOT EXISTS publish_jobs_shop ON publish_jobs(shop_id,created_at DESC);"];
const initialized=new WeakMap();
export async function ensureSocialSchema(db){
 if(initialized.has(db))return initialized.get(db);
 const pending=(async()=>{
  await db.batch(SOCIAL_SCHEMA.slice(2).map(s=>db.prepare(s)));await ensureChannelStore(db);
  const hasURL=async()=> (await db.prepare('PRAGMA table_info(publish_jobs)').all()).results.some(c=>c.name==='result_url');
  if(!await hasURL())try{await db.prepare('ALTER TABLE publish_jobs ADD COLUMN result_url TEXT').run();}catch(e){if(!await hasURL())throw e;}
  await db.prepare('CREATE INDEX IF NOT EXISTS publish_jobs_due ON publish_jobs(status,next_attempt_at)').run();
 })();initialized.set(db,pending);try{await pending;}catch(e){initialized.delete(db);throw e;}
}
function decodeKey(env){if(typeof env.SOCIAL_TOKEN_KEY!=='string')throw Error('KEY_MISSING');let x=Uint8Array.from(atob(env.SOCIAL_TOKEN_KEY),c=>c.charCodeAt(0));if(x.length!==32)throw Error('KEY_INVALID');return x;}
const b64=x=>btoa(String.fromCharCode(...x)),un64=x=>Uint8Array.from(atob(x),c=>c.charCodeAt(0));
async function key(env){return crypto.subtle.importKey('raw',decodeKey(env),'AES-GCM',false,['encrypt','decrypt']);}
export async function encryptToken(env,token){const iv=crypto.getRandomValues(new Uint8Array(12));const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await key(env),new TextEncoder().encode(token)));return {cipher:b64(cipher),iv:b64(iv)};}
export async function decryptToken(env,cipher,iv){return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:un64(iv)},await key(env),un64(cipher)));}
export async function callTelegram(token,method,body){
 const r=await fetch('https://api.telegram.org/bot'+token+'/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(12000)});
 const data=await r.json().catch(()=>({}));
 if(!r.ok||data.ok!==true){const e=Error('TELEGRAM_FAILED');e.status=r.status;e.retryAfter=Number(data.parameters?.retry_after)||0;throw e;}
 return data.result;
}
async function input(req){if(!(req.headers.get('content-type')||'').startsWith('application/json'))return null;const s=await req.text();if(s.length>8*1024*1024)return null;try{const j=JSON.parse(s);return j&&typeof j==='object'&&!Array.isArray(j)?j:null;}catch{return null;}}
const view=a=>({id:a.id,name:a.name,provider:a.provider,targetId:a.external_id,status:a.status==='connected'?'active':a.status});
const jobView=j=>({provider:j.provider,url:j.result_url||null,nextAttemptAt:j.next_attempt_at||0,id:j.id,accountId:j.account_id,status:j.status,kind:j.kind,attempts:j.attempts,remoteMessageId:j.remote_message_id,errorCode:j.error_code});
const fail=(json,status,code)=>json({error:code,code},status);
export async function handleSocial(req,env,who,json){
 if(!env.DB)return fail(json,503,'db_missing');
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
 const provider=req.headers.get('X-Channel-Provider')||'all';
 if(section==='accounts'&&!resource&&req.method==='GET'){
  if(!ctx.can('channels.view'))return fail(json,403,'forbidden');
  const {results}=await db.prepare('SELECT id,name,provider,external_id,status FROM channels WHERE shop_id=? AND (?=\'all\' OR provider=?) ORDER BY created_at DESC').bind(shop,provider,provider).all();return json({accounts:results.map(view)});
 }
 if(section==='accounts'&&!resource&&req.method==='POST'){
  if(provider!=='all'&&provider!=='telegram')return fail(json,404,'not_found');
  if(!ctx.can('channels.configure_token')||ctx.shop.status!=='active')return fail(json,403,'forbidden');
  const data=await input(req),token=data?.token,chat=data?.chatId;
  if(typeof token!=='string'||!/^\d{6,15}:[\w-]{25,80}$/.test(token)||typeof chat!=='string'||!/^(-?\d{5,22}|@[\w]{5,32})$/.test(chat))return fail(json,400,'invalid_input');
  let bot,target;try{bot=await callTelegram(token,'getMe',{});target=await callTelegram(token,'getChat',{chat_id:chat});}catch{return fail(json,422,'telegram_verification_failed');}
  if(!bot?.is_bot||!target?.id)return fail(json,422,'telegram_verification_failed');
  const encrypted=await encryptToken(env,token),t=now(),id='sa_'+crypto.randomUUID(),targetId=String(target.id);
  await db.prepare("INSERT INTO channels(id,shop_id,provider,name,external_id,token,token_iv,status,connected_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'connected',?,?,?) ON CONFLICT(shop_id,provider,external_id) DO UPDATE SET token=excluded.token,token_iv=excluded.token_iv,status='connected',updated_at=excluded.updated_at")
   .bind(id,shop,'telegram',String(target.title||target.username||bot.username||'Telegram').slice(0,80),targetId,encrypted.cipher,encrypted.iv,who.owner,t,t).run();
  await audit(db,{shopId:shop,actor:who.owner,action:'social.connect',target:targetId,detail:{provider:'telegram'}});
  return json({ok:true,targetId},201);
 }
 if(section==='accounts'&&resource&&!action&&req.method==='DELETE'){
  if(!ctx.can('channels.configure_token'))return fail(json,403,'forbidden');
  const account=await db.prepare('SELECT provider FROM channels WHERE id=? AND shop_id=? AND (?=\'all\' OR provider=?)').bind(resource,shop,provider,provider).first();
  if(!account)return fail(json,404,'not_found');
  if(account.provider==='zalo'){
   const target=new URL(req.url);target.pathname='/channels/zalo';
   return handleChannels(new Request(target,{method:'DELETE',headers:req.headers}),env,who,json);
  }
  const r=await db.prepare("UPDATE channels SET status='revoked',token='',token_iv='',updated_at=? WHERE id=? AND shop_id=? AND (?='all' OR provider=?)").bind(now(),resource,shop,provider,provider).run();
  if(r.meta.changes!==1)return fail(json,404,'not_found');
  await db.prepare("UPDATE publish_jobs SET status='failed',error_code='account_revoked',updated_at=? WHERE shop_id=? AND account_id=? AND status IN ('pending','retryable')").bind(now(),shop,resource).run();
  await audit(db,{shopId:shop,actor:who.owner,action:'channels.disconnect',target:resource});return json({ok:true});
 }
 if(section==='jobs'&&resource==='events'&&!action&&req.method==='GET'){
  if(!ctx.can('channels.view'))return fail(json,403,'forbidden');
  const url=new URL(req.url),cursor=url.searchParams.get('cursor')||'';
  const raw=Number(url.searchParams.get('wait')??20),wait=Number.isFinite(raw)?Math.max(0,Math.min(20,raw)):20;
  const deadline=Date.now()+wait*1000;
  while(true){
   if(req.signal.aborted)return fail(json,408,'request_aborted');
   const current=await resolveShop(env,who,req);
   if(current.error||!current.can('channels.view'))return fail(json,403,'forbidden');
   const jobs=await listJobs(db,shop,provider);
   const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(jobs))));
   const next=Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
   if(next!==cursor||Date.now()>=deadline)return json({jobs,cursor:next,changed:next!==cursor});
   await new Promise(resolve=>{const done=()=>{clearTimeout(timer);req.signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,Math.min(1000,deadline-Date.now()));req.signal.addEventListener('abort',done,{once:true});});
  }
 }
 if(section==='jobs'&&!resource&&req.method==='GET'){
  if(!ctx.can('channels.view'))return fail(json,403,'forbidden');
  return json({jobs:await listJobs(db,shop,provider)});
 }
 if(section==='jobs'&&!resource&&req.method==='POST'){
  if(!ctx.can('channels.operate')&&!ctx.can('drafts.publish'))return fail(json,403,'forbidden');
  if(ctx.shop.status!=='active')return fail(json,403,'shop_suspended');
  const data=await input(req),idem=req.headers.get('Idempotency-Key')||data?.idempotencyKey;
  if(typeof idem!=='string'||!/^[\w-]{12,100}$/.test(idem)||typeof data?.accountId!=='string')return fail(json,400,'invalid_input');
  const a=await db.prepare("SELECT id,provider,external_id FROM channels WHERE shop_id=? AND id=? AND status='connected'").bind(shop,data.accountId).first();
  if(!a||(provider!=='all'&&a.provider!==provider))return fail(json,404,'account_missing');
  try{validatePost(a.provider,data);}catch(e){return fail(json,e.status||400,e.code||'invalid_input');}
  const scheduled=req.headers.get('X-Channel-Schedule')==='1';
  if(scheduled&&(!Number.isFinite(data.runAt)||Math.floor(data.runAt)<=now()))return fail(json,400,'invalid_schedule');
  const payload=JSON.stringify({externalId:a.external_id,text:data.text,photoUrl:data.kind==='photo'?(data.photoUrl||null):null,...(a.provider==='zalo'?{title:data.title||'',images:data.images||[],author:data.author||ctx.shop.name}:{} )}),t=now();
  await db.prepare("INSERT OR IGNORE INTO publish_jobs(id,shop_id,account_id,idempotency_key,kind,payload,status,created_by,created_at,updated_at,next_attempt_at) VALUES(?,?,?,?,?,?,'pending',?,?,?,?)").bind('pj_'+crypto.randomUUID(),shop,a.id,idem,data.kind,payload,who.owner,t,t,scheduled?Math.floor(data.runAt):0).run();
  const j=await db.prepare('SELECT * FROM publish_jobs WHERE shop_id=? AND idempotency_key=?').bind(shop,idem).first();
  if(j.account_id!==a.id||j.kind!==data.kind||j.payload!==payload||(scheduled&&j.next_attempt_at!==Math.floor(data.runAt)))return fail(json,409,'idempotency_conflict');
  if(scheduled)return json({ok:true,id:j.id,runAt:j.next_attempt_at,status:'scheduled',job:jobView(j)},201);
  return deliver(j,db,env,shop,json);
 }
 if(section==='jobs'&&resource&&['retry','run'].includes(action)&&req.method==='POST'){
  if(!ctx.can('channels.operate')&&!ctx.can('drafts.publish'))return fail(json,403,'forbidden');
  if(ctx.shop.status!=='active')return fail(json,403,'shop_suspended');
  const j=await db.prepare('SELECT * FROM publish_jobs WHERE shop_id=? AND id=?').bind(shop,resource).first();
  if(!j)return fail(json,404,'not_found');
  const account=await db.prepare('SELECT provider FROM channels WHERE shop_id=? AND id=?').bind(shop,j.account_id).first();
  if(provider!=='all'&&account?.provider!==provider)return fail(json,404,'not_found');
  if(action==='run'&&j.status==='pending'){await db.prepare("UPDATE publish_jobs SET next_attempt_at=0,updated_at=? WHERE shop_id=? AND id=? AND status='pending'").bind(now(),shop,j.id).run();j.next_attempt_at=0;}
  return deliver(j,db,env,shop,json);
 }
 return fail(json,404,'not_found');
}
async function deliver(j,db,env,shop,json){
 if(j.next_attempt_at>now())return json({job:jobView(j),retryAfter:j.next_attempt_at-now()},429);
 if(!['pending','retryable'].includes(j.status))return json({ok:j.status==='sent',id:j.remote_message_id,url:j.result_url||null,job:jobView(j)},j.status==='sent'?200:409);
 const c=await db.prepare("UPDATE publish_jobs SET status='sending',attempts=attempts+1,updated_at=? WHERE shop_id=? AND id=? AND status IN ('pending','retryable') AND next_attempt_at<=?").bind(now(),shop,j.id,now()).run();
 if(c.meta.changes!==1)return fail(json,409,'in_progress');
 const a=await db.prepare("SELECT * FROM channels WHERE shop_id=? AND id=? AND status='connected'").bind(shop,j.account_id).first();
 if(!a){await db.prepare("UPDATE publish_jobs SET status='failed',error_code='account_revoked' WHERE id=?").bind(j.id).run();return fail(json,409,'account_revoked');}
 let status='unknown',error='delivery_uncertain',remote=null,nextAttempt=0,resultUrl=null;
 try{const result=await publishFor(a.provider,env,db,a,j);remote=result.id;resultUrl=result.url||null;
  status='sent';error=null;
 }catch(e){const decision=retryDecision(e,j.attempts+1);status=decision.status;error=decision.code;nextAttempt=decision.delay?now()+decision.delay:0;
 if(decision.reauth||metaDenied(e)){status='failed';error='provider_denied';await db.prepare("UPDATE channels SET status='reauth_required',updated_at=? WHERE id=? AND shop_id=? AND token IS ?").bind(now(),a.id,shop,a.token).run();}
 }

 await db.prepare('UPDATE publish_jobs SET status=?,remote_message_id=?,error_code=?,updated_at=?,next_attempt_at=?,result_url=? WHERE id=? AND shop_id=?').bind(status,remote,error,now(),nextAttempt,resultUrl,j.id,shop).run();
 console.info(JSON.stringify({event:'publish.result',provider:a.provider,status,code:error,attempt:j.attempts+1}));
 await audit(db,{shopId:shop,actor:j.created_by,action:'social.publish',target:j.id,detail:{status,error}});
 return json({ok:status==='sent',id:remote,url:resultUrl,job:{...jobView(j),status,attempts:j.attempts+1,remoteMessageId:remote,errorCode:error}},status==='sent'?200:status==='retryable'?429:502);
}

export async function runDuePublishJobs(env){
 const db=env.DB;await ensureSocialSchema(db);
 await importLegacyScheduledPosts(db);
 const {results}=await db.prepare("SELECT j.* FROM publish_jobs j JOIN shops s ON s.id=j.shop_id WHERE j.status IN ('pending','retryable') AND j.next_attempt_at<=? AND s.status='active' ORDER BY j.next_attempt_at,j.created_at LIMIT 25").bind(now()).all();
 let processed=0;
 for(const j of results){try{await deliver(j,db,env,j.shop_id,(v,status=200)=>({status,data:v}));}catch{console.error(JSON.stringify({event:'publish.result',code:'job_processing_failed'}));}processed++;}
 await db.prepare(`UPDATE scheduled_posts SET status=CASE (SELECT status FROM publish_jobs j WHERE j.id=scheduled_posts.id) WHEN 'sent' THEN 'posted' WHEN 'pending' THEN 'scheduled' WHEN 'retryable' THEN 'scheduled' WHEN 'sending' THEN 'processing' WHEN 'unknown' THEN 'unknown' ELSE 'failed' END,
 result_id=(SELECT remote_message_id FROM publish_jobs j WHERE j.id=scheduled_posts.id),result_url=(SELECT result_url FROM publish_jobs j WHERE j.id=scheduled_posts.id),error=(SELECT error_code FROM publish_jobs j WHERE j.id=scheduled_posts.id),updated_at=? WHERE id IN (SELECT id FROM publish_jobs)`).bind(now()).run();
 return {processed};
}

async function listJobs(db,shop,provider){
 const {results}=await db.prepare("SELECT j.id,j.account_id,j.status,j.kind,j.attempts,j.remote_message_id,j.error_code,j.result_url,j.next_attempt_at,c.provider FROM publish_jobs j LEFT JOIN channels c ON c.id=j.account_id AND c.shop_id=j.shop_id WHERE j.shop_id=? AND (?='all' OR c.provider=?) ORDER BY j.updated_at DESC,j.id DESC LIMIT 200").bind(shop,provider,provider).all();
 return results.map(jobView);
}

export async function importLegacyScheduledPosts(db){
 // Import legacy schedule metadata once into the shared queue, preserving terminal/uncertain states.
 await db.prepare(`INSERT OR IGNORE INTO publish_jobs(id,shop_id,account_id,idempotency_key,kind,payload,status,attempts,next_attempt_at,remote_message_id,error_code,created_by,created_at,updated_at,result_url)
 SELECT s.id,s.shop_id,coalesce(c.id,'missing:'||s.shop_id),'legacy-'||s.id,'photo',json_object('externalId',c.external_id,'text',s.content,'title',s.title,'images',json(CASE WHEN json_valid(s.images) THEN s.images ELSE '[]' END),'author',s.author),
 CASE s.status WHEN 'scheduled' THEN 'pending' WHEN 'posted' THEN 'sent' WHEN 'processing' THEN 'unknown' ELSE 'failed' END,coalesce(s.attempts,0),s.run_at,s.result_id,s.error,coalesce(s.created_by,'system'),coalesce(s.created_at,0),coalesce(s.updated_at,0),s.result_url
 FROM scheduled_posts s LEFT JOIN channels c ON c.shop_id=s.shop_id AND c.provider=s.provider WHERE s.provider='zalo'`).run();
}
