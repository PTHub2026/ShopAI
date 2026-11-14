import {graphRequest} from './meta.js';
import {ensureReplySchema,matchReply} from './replies.js';
import {ensureChannelStore} from './channel-store.js';
import {decryptToken,callTelegram} from './social.js';
import {resolveShop,audit} from './shops.js';
import {can} from './permissions.js';
const now=()=>Math.floor(Date.now()/1000),uid=p=>p+crypto.randomUUID();
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const schema=[
 `CREATE TABLE IF NOT EXISTS reply_bindings(account_id TEXT PRIMARY KEY,shop_id TEXT NOT NULL,provider TEXT NOT NULL,external_id TEXT NOT NULL,bot_id TEXT,credential TEXT NOT NULL,activation_id TEXT NOT NULL DEFAULT '',enabled INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL)`,
 `CREATE UNIQUE INDEX IF NOT EXISTS reply_active_target ON reply_bindings(provider,external_id) WHERE enabled=1`,
 `CREATE TABLE IF NOT EXISTS reply_conversations(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL,account_id TEXT NOT NULL,remote_id TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',paused INTEGER NOT NULL DEFAULT 0,tags TEXT NOT NULL DEFAULT '[]',last_message_at INTEGER NOT NULL,last_message TEXT NOT NULL,processing_event TEXT,assigned_to TEXT,UNIQUE(account_id,remote_id))`,
 `CREATE INDEX IF NOT EXISTS reply_conversations_shop ON reply_conversations(shop_id,last_message_at DESC,id)`,
 `CREATE TABLE IF NOT EXISTS reply_events(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL,account_id TEXT NOT NULL,conversation_id TEXT NOT NULL,event_key TEXT NOT NULL,payload TEXT NOT NULL,credential TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',script_name TEXT,error_code TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(account_id,event_key))`,
 `CREATE INDEX IF NOT EXISTS reply_events_queue ON reply_events(status,created_at)`,
 `CREATE TABLE IF NOT EXISTS reply_messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,event_id TEXT NOT NULL,author TEXT NOT NULL,text TEXT NOT NULL,script_name TEXT,created_at INTEGER NOT NULL,UNIQUE(event_id,author))`
];
const initialized=new WeakMap();
export async function ensureMessagingSchema(db){
 if(initialized.has(db))return initialized.get(db);
 const task=(async()=>{await ensureChannelStore(db);await ensureReplySchema(db);await db.batch(schema.map(s=>db.prepare(s)));
  for(const [table,name,type] of [['reply_bindings','activation_id',"TEXT NOT NULL DEFAULT ''"],['reply_conversations','processing_event','TEXT'],['reply_conversations','assigned_to','TEXT']]){
   const has=async()=>(await db.prepare('PRAGMA table_info('+table+')').all()).results.some(c=>c.name===name);
   if(!await has())try{await db.prepare('ALTER TABLE '+table+' ADD COLUMN '+name+' '+type).run();}catch(e){if(!await has())throw e;}
  }
 })();initialized.set(db,task);try{await task;}catch(e){initialized.delete(db);throw e;}
}
const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
async function digest(text){return hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));}
async function fingerprint(c){return digest([c.provider,c.external_id,c.token,c.token_iv].join('\0'));}
async function mac(secret,text){const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return hex(await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(text)));}
function equal(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;}
async function bounded(req,max=1048576){const reader=req.body?.getReader();if(!reader)throw Error('invalid_body');const chunks=[];let size=0;while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw Error('body_too_large');}chunks.push(value);}const bytes=new Uint8Array(size);let p=0;for(const c of chunks){bytes.set(c,p);p+=c.length;}return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
async function graph(env,token,path,body){const r=await fetch('https://graph.facebook.com/'+(env.META_GRAPH_VERSION||'v26.0')+'/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(12000)});const data=await r.json().catch(()=>({}));if(!r.ok||data.error)throw Error('meta_request_failed');return data;}
function readiness(env,c){if(c.status!=='connected')return 'channel_disconnected';if(!env.SOCIAL_TOKEN_KEY)return 'social_key_missing';if(!env.PUBLIC_ORIGIN||!/^https:\/\//.test(env.PUBLIC_ORIGIN))return 'public_origin_missing';if(c.provider==='telegram')return null;if(c.provider==='facebook')return env.META_REPLY_WEBHOOK_READY==='true'&&env.META_APP_SECRET&&env.META_APP_ID&&env.META_REPLY_VERIFY_TOKEN?null:'meta_webhook_not_ready';return 'provider_unsupported';}
const conversation=c=>({id:c.id,accountId:c.account_id,provider:c.provider,name:c.name,status:c.status,paused:!!c.paused,assignedTo:c.assigned_to||null,tags:JSON.parse(c.tags),lastMessageAt:c.last_message_at,lastMessage:c.last_message});
async function live(db,b){const c=await db.prepare("SELECT c.* FROM channels c JOIN reply_bindings b ON b.account_id=c.id AND b.shop_id=c.shop_id JOIN shops s ON s.id=c.shop_id WHERE c.id=? AND b.enabled=1 AND b.bot_id IS NOT NULL AND c.status='connected' AND s.status='active'").bind(b.account_id).first();return c&&await fingerprint(c)===b.credential?c:null;}
async function verifyMessenger(env,channel,token){
 const appToken=env.META_APP_ID+'|'+env.META_APP_SECRET;
 const info=await graphRequest(env,'debug_token',appToken,{input_token:token,method:'GET'},'POST');
 const scopes=info.data?.scopes;
 if(!info.data?.is_valid||String(info.data.app_id)!==String(env.META_APP_ID)||!Array.isArray(scopes)||!['pages_messaging','pages_manage_metadata'].every(scope=>scopes.includes(scope)))throw Error('meta_messaging_permissions_missing');
 const page=await graph(env,token,'me?fields=id');
 if(String(page.id)!==channel.external_id)throw Error('meta_page_mismatch');
}
async function activate(env,c,activationId){
 const stillRequested=async()=>{const b=await env.DB.prepare('SELECT enabled,activation_id FROM reply_bindings WHERE account_id=?').bind(c.id).first();if(!b?.enabled||b.activation_id!==activationId)throw Error('channel_disabled');};
 const token=await decryptToken(env,c.token,c.token_iv);let botId='';
 if(c.provider==='telegram'){
  const bot=await callTelegram(token,'getMe',{}),chat=await callTelegram(token,'getChat',{chat_id:c.external_id});
  if(!bot?.is_bot||!Number.isSafeInteger(bot.id)||bot.id<=0||String(chat?.id)!==c.external_id||!['group','supergroup','private'].includes(chat.type))throw Error('telegram_target_unsupported');
  botId=String(bot.id);const url=env.PUBLIC_ORIGIN.replace(/\/$/,'')+'/webhooks/replies/telegram/'+botId;
  const webhook=await callTelegram(token,'getWebhookInfo',{});if(webhook.url&&webhook.url!==url)throw Error('telegram_webhook_owned_elsewhere');
  const current=await env.DB.prepare('SELECT * FROM channels WHERE id=?').bind(c.id).first();if(!current||current.status!=='connected'||await fingerprint(c)!==await fingerprint(current))throw Error('credential_changed');
  await stillRequested();
  await callTelegram(token,'setWebhook',{url,secret_token:await mac(env.SOCIAL_TOKEN_KEY,'reply-telegram:'+botId),allowed_updates:['message'],drop_pending_updates:false});
 }else{
  await verifyMessenger(env,c,token);
  const current=await env.DB.prepare('SELECT * FROM channels WHERE id=?').bind(c.id).first();if(!current||current.status!=='connected'||await fingerprint(c)!==await fingerprint(current))throw Error('credential_changed');
  await stillRequested();
  await graph(env,token,encodeURIComponent(c.external_id)+'/subscribed_apps',{subscribed_fields:['messages','messaging_postbacks']});
 }
 return botId;
}
export async function handleMessaging(req,env,who,respond=json){
 const fail=(s,code)=>respond({error:code,code},s),url=new URL(req.url),parts=url.pathname.replace(/^\/api\/replies\//,'').split('/');
 if(!env.DB)return fail(503,'db_missing');if(!who?.owner)return fail(401,'unauthorized');
 if(req.method!=='GET'&&req.headers.get('Origin')!==url.origin)return fail(403,'same_origin_required');
 const ctx=await resolveShop(env,who,req);if(ctx.error)return respond({error:ctx.error,code:ctx.code},ctx.status);
 const edit=req.method!=='GET',allConversations=ctx.can('conversations.assign');
 const needed=parts[0]==='metrics'?'reports.view':parts[0]==='channels'||parts[0]==='activity'?(edit?'channels.configure_token':'channels.view'):edit?'conversations.reply':'conversations.view_assigned';
 if(!ctx.can(needed))return fail(403,'forbidden');
 if(edit){let limit;try{limit=await env.AI_RATE_LIMITER?.limit({key:'reply-messaging:'+who.owner});}catch{}if(!limit)return fail(503,'rate_limiter_unavailable');if(!limit.success)return fail(429,'rate_limited');if(ctx.shop.status!=='active')return fail(403,'shop_suspended');}
 await ensureMessagingSchema(env.DB);const db=env.DB,shop=ctx.shop.id;
 if(parts[0]==='channels'&&!parts[1]&&req.method==='GET'){
  const {results}=await db.prepare('SELECT c.*,b.enabled,b.credential,b.bot_id FROM channels c LEFT JOIN reply_bindings b ON b.account_id=c.id WHERE c.shop_id=? ORDER BY c.created_at DESC').bind(shop).all();
  return respond({channels:await Promise.all(results.map(async c=>{const reason=readiness(env,c),stale=c.credential&&c.credential!==await fingerprint(c);return {id:c.id,accountId:c.id,name:c.name,provider:c.provider,externalId:c.external_id,status:c.status,enabled:!!c.enabled&&c.bot_id!==null&&!stale&&c.status==='connected',ready:!reason,reason:reason||(stale?'credential_changed':null)};}))});
 }
 if(parts[0]==='channels'&&parts[1]&&parts[2]==='diagnostics'&&parts.length===3&&req.method==='GET'){
  if(!ctx.can('channels.configure_token')||ctx.shop.status!=='active')return fail(403,'forbidden');
  const channel=await db.prepare("SELECT * FROM channels WHERE id=? AND shop_id=? AND provider='facebook'").bind(parts[1],shop).first();
  if(!channel)return fail(404,'not_found');
  const reason=readiness(env,channel);
  if(reason)return respond({ready:false,reason});
  try{
   await verifyMessenger(env,channel,await decryptToken(env,channel.token,channel.token_iv));
   return respond({ready:true,reason:null});
  }catch(error){
   const reason=['meta_messaging_permissions_missing','meta_page_mismatch'].includes(error.message)?error.message:'provider_verification_failed';
   return respond({ready:false,reason});
  }
 }
 if(parts[0]==='channels'&&parts[1]&&!parts[2]&&req.method==='PATCH'){
  let data;try{data=JSON.parse(await bounded(req,8192));}catch{return fail(400,'invalid_input');}if(!data||typeof data!=='object'||Array.isArray(data)||typeof data.enabled!=='boolean')return fail(400,'invalid_input');
  const c=await db.prepare('SELECT * FROM channels WHERE id=? AND shop_id=?').bind(parts[1],shop).first();if(!c)return fail(404,'not_found');
  if(!data.enabled){await db.prepare('UPDATE reply_bindings SET enabled=0,updated_at=? WHERE account_id=? AND shop_id=?').bind(now(),c.id,shop).run();return respond({ok:true,enabled:false});}
  const reason=readiness(env,c);if(reason)return fail(409,reason);
  const fp=await fingerprint(c),activationId=uid('ra_');let botId;
  // Reserve before provider IO to enforce one shop per immutable target, including concurrent activations.
  try{await db.prepare('INSERT INTO reply_bindings(account_id,shop_id,provider,external_id,credential,activation_id,enabled,updated_at) VALUES(?,?,?,?,?,?,1,?) ON CONFLICT(account_id) DO UPDATE SET credential=excluded.credential,activation_id=excluded.activation_id,bot_id=NULL,enabled=1,updated_at=excluded.updated_at').bind(c.id,shop,c.provider,c.external_id,fp,activationId,now()).run();}catch{return fail(409,'target_already_active');}
  try{botId=await activate(env,c,activationId);const current=await db.prepare('SELECT * FROM channels WHERE id=?').bind(c.id).first();if(!current||current.status!=='connected'||await fingerprint(current)!==fp)throw Error('credential_changed');
   const updated=await db.prepare('UPDATE reply_bindings SET bot_id=? WHERE account_id=? AND credential=? AND activation_id=? AND enabled=1').bind(botId,c.id,fp,activationId).run();if(updated.meta.changes!==1)throw Error('channel_disabled');
  }catch(e){await db.prepare('UPDATE reply_bindings SET enabled=0 WHERE account_id=? AND credential=? AND activation_id=?').bind(c.id,fp,activationId).run();return fail(422,['telegram_webhook_owned_elsewhere','telegram_target_unsupported','meta_messaging_permissions_missing','meta_page_mismatch','credential_changed','channel_disabled'].includes(e.message)?e.message:'provider_verification_failed');}
  await audit(db,{shopId:shop,actor:who.owner,action:'replies.channel.enable',target:c.id});return respond({ok:true,enabled:true});
 }
 if(parts[0]==='metrics'&&!parts[1]&&req.method==='GET'){
  const days=Number(url.searchParams.get('days')||7);if(![7,14,30,90].includes(days))return fail(400,'invalid_days');
  const since=now()-days*86400,config=await db.prepare('SELECT document FROM reply_configs WHERE shop_id=?').bind(shop).first();let slaMinutes=15;try{const n=JSON.parse(config?.document||'{}').settings?.slaMin;if(Number.isInteger(n)&&n>0)slaMinutes=n;}catch{}
  const counts=await db.prepare(`SELECT COUNT(DISTINCT m.conversation_id) AS conversations,coalesce(SUM(CASE WHEN m.author='customer' THEN 1 ELSE 0 END),0) AS inboundMessages,coalesce(SUM(CASE WHEN m.author IN ('bot','agent') THEN 1 ELSE 0 END),0) AS outboundMessages FROM reply_messages m JOIN reply_conversations v ON v.id=m.conversation_id WHERE v.shop_id=? AND m.created_at>=?`).bind(shop,since).first();
  const stats=await db.prepare(`WITH first_in AS (SELECT m.conversation_id,MIN(m.created_at) AS incoming FROM reply_messages m JOIN reply_conversations v ON v.id=m.conversation_id WHERE v.shop_id=? AND m.author='customer' GROUP BY m.conversation_id HAVING MIN(m.created_at)>=?),delays AS (SELECT (SELECT MIN(o.created_at) FROM reply_messages o WHERE o.conversation_id=f.conversation_id AND o.author IN ('bot','agent') AND o.created_at>=f.incoming)-f.incoming AS seconds FROM first_in f),ranked AS (SELECT seconds,ROW_NUMBER() OVER(ORDER BY seconds) AS position,COUNT(*) OVER() AS total FROM delays WHERE seconds IS NOT NULL) SELECT COUNT(*) AS respondedConversations,AVG(seconds) AS firstReplyAverageSeconds,MIN(CASE WHEN position>=ceil(total*0.9) THEN seconds END) AS firstReplyP90Seconds,coalesce(SUM(CASE WHEN seconds<=? THEN 1 ELSE 0 END),0) AS slaMet FROM ranked`).bind(shop,since,slaMinutes*60).first();
  return respond({days,...counts,...stats,slaMinutes});
 }
 if(parts[0]==='activity'&&req.method==='GET'){const {results}=await db.prepare('SELECT id,account_id AS accountId,status,script_name AS scriptName,error_code AS errorCode,created_at AS createdAt FROM reply_events WHERE shop_id=? ORDER BY created_at DESC,id DESC LIMIT 100').bind(shop).all();return respond({events:results});}
 if(parts[0]==='conversations'&&!parts[1]&&req.method==='GET'){
  const q=(url.searchParams.get('q')||'').slice(0,100),status=url.searchParams.get('status')||'',cursor=url.searchParams.get('cursor')||'';
  const split=cursor.indexOf(':'),cursorTime=cursor?Number(cursor.slice(0,split)):0,cursorId=cursor.slice(split+1);if(cursor&&(split<1||!Number.isSafeInteger(cursorTime)||cursorTime<0||cursorId.length>100))return fail(400,'invalid_cursor');
  const {results}=await db.prepare("SELECT v.*,c.provider FROM reply_conversations v JOIN channels c ON c.id=v.account_id WHERE v.shop_id=? AND (?='' OR v.name LIKE ? OR v.last_message LIKE ?) AND (?='' OR v.status=?) AND (?=1 OR v.assigned_to=?) AND (?='' OR v.last_message_at<? OR (v.last_message_at=? AND v.id<?)) ORDER BY v.last_message_at DESC,v.id DESC LIMIT 51").bind(shop,q,'%'+q+'%','%'+q+'%',status,status,Number(allConversations),who.owner,cursor,cursorTime,cursorTime,cursorId).all();const rows=results.slice(0,50);return respond({conversations:rows.map(conversation),cursor:results.length>50?rows.at(-1).last_message_at+':'+rows.at(-1).id:null});
 }
 if(parts[0]==='conversations'&&parts[1]&&!parts[2]){
  const c=await db.prepare('SELECT v.*,c.provider FROM reply_conversations v JOIN channels c ON c.id=v.account_id WHERE v.id=? AND v.shop_id=?').bind(parts[1],shop).first();if(!c||!allConversations&&c.assigned_to!==who.owner)return fail(404,'not_found');
  if(req.method==='GET'){const {results}=await db.prepare('SELECT id,author AS "from",text,created_at AS createdAt,script_name AS scriptName FROM reply_messages WHERE conversation_id=? ORDER BY created_at,rowid LIMIT 500').bind(c.id).all();return respond({conversation:conversation(c),messages:results});}
  if(req.method==='PATCH'){
   let d;try{d=JSON.parse(await bounded(req,8192));}catch{return fail(400,'invalid_input');}
   if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).some(k=>!['paused','status','tags','assignedTo'].includes(k))||d.paused!==undefined&&typeof d.paused!=='boolean'||d.status!==undefined&&!['open','closed','handoff'].includes(d.status)||d.tags!==undefined&&(!Array.isArray(d.tags)||d.tags.length>20||d.tags.some(t=>typeof t!=='string'||!t.trim()||t.length>100)))return fail(400,'invalid_input');
   if(d.assignedTo!==undefined){
    if(!allConversations)return fail(403,'forbidden');if(d.assignedTo!==null){if(typeof d.assignedTo!=='string'||d.assignedTo.length>256)return fail(400,'invalid_assignee');const member=await db.prepare('SELECT role,can_publish FROM shop_members WHERE shop_id=? AND user_id=?').bind(shop,d.assignedTo).first();if(!can(member,'conversations.reply'))return fail(400,'invalid_assignee');}
   }
   const updated=await db.prepare('UPDATE reply_conversations SET paused=?,status=?,tags=?,assigned_to=? WHERE id=? AND shop_id=? AND (?=1 OR assigned_to=?)').bind(d.paused===undefined?c.paused:Number(d.paused),d.status||c.status,JSON.stringify(d.tags||JSON.parse(c.tags)),d.assignedTo===undefined?c.assigned_to:d.assignedTo,c.id,shop,Number(allConversations),who.owner).run();if(updated.meta.changes!==1)return fail(404,'not_found');return respond({ok:true});
  }
 }
 return fail(404,'not_found');
}
async function enqueue(env,b,e){
 const db=env.DB,t=now();if(!Number.isSafeInteger(e.time)||e.time<t-86400||e.time>t+300||!e.text||e.text.length>10000)return;
 if(!await live(db,b))return;
 const cid='rc_'+await digest(b.account_id+'\0'+e.remote),eid=uid('re_');
 await db.batch([
  db.prepare("INSERT INTO reply_conversations(id,shop_id,account_id,remote_id,name,last_message_at,last_message) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id,remote_id) DO NOTHING").bind(cid,b.shop_id,b.account_id,e.remote,e.name.slice(0,100),e.time,e.text),
  db.prepare("INSERT OR IGNORE INTO reply_events(id,shop_id,account_id,conversation_id,event_key,payload,credential,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(eid,b.shop_id,b.account_id,cid,e.key,JSON.stringify(e),b.credential,t,t)
 ]);
}
export async function handleReplyWebhook(req,env,ctx={}){
 const url=new URL(req.url),meta=url.pathname==='/webhooks/replies/meta',telegram=url.pathname.match(/^\/webhooks\/replies\/telegram\/(\d{1,20})$/);
 if(!meta&&!telegram)return json({error:'not_found'},404);
 if(meta&&req.method==='GET')return env.META_REPLY_VERIFY_TOKEN&&url.searchParams.get('hub.mode')==='subscribe'&&equal(url.searchParams.get('hub.verify_token'),env.META_REPLY_VERIFY_TOKEN)?new Response(url.searchParams.get('hub.challenge')||''):json({error:'verification_failed'},403);
 if(req.method!=='POST')return json({error:'method_not_allowed'},405);
 // Authenticate before reading/parsing/persisting incoming content.
 if(telegram&&(!env.SOCIAL_TOKEN_KEY||!equal(req.headers.get('X-Telegram-Bot-Api-Secret-Token'),await mac(env.SOCIAL_TOKEN_KEY,'reply-telegram:'+telegram[1]))))return json({error:'invalid_secret'},403);
 if(meta&&(!env.META_APP_SECRET||!/^sha256=[a-f0-9]{64}$/.test(req.headers.get('X-Hub-Signature-256')||'')))return json({error:'invalid_signature'},403);
 let raw;try{raw=await bounded(req);}catch{return json({error:'invalid_body'},400);}
 if(meta&&!equal(req.headers.get('X-Hub-Signature-256'),'sha256='+await mac(env.META_APP_SECRET,raw)))return json({error:'invalid_signature'},403);
 let body;try{body=JSON.parse(raw);if(!body||Array.isArray(body)||typeof body!=='object')throw Error();}catch{return json({error:'invalid_json'},400);}
 if(!env.DB)return json({error:'db_missing'},503);await ensureMessagingSchema(env.DB);
 if(telegram){
  const m=body.message;if(m&&!m.from?.is_bot&&typeof m.text==='string'&&Number.isSafeInteger(body.update_id)&&Number.isSafeInteger(m.message_id)){
   const {results}=await env.DB.prepare("SELECT * FROM reply_bindings WHERE provider='telegram' AND bot_id=? AND external_id=? AND enabled=1").bind(telegram[1],String(m.chat?.id)).all();
   for(const b of results)await enqueue(env,b,{key:String(body.update_id),remote:String(m.chat.id),name:String(m.from?.first_name||m.chat.title||'Telegram'),text:m.text,time:Number(m.date),messageId:m.message_id});
  }
 }else{
  if(body.object!=='page'||!Array.isArray(body.entry))return json({error:'invalid_event'},400);
  const events=body.entry.flatMap(entry=>(Array.isArray(entry?.messaging)?entry.messaging:[]).filter(e=>e&&typeof e==='object'&&!Array.isArray(e)).map(e=>({entry,e})));if(events.length>50)return json({error:'too_many_events'},400);
  for(const {entry,e} of events){if(e.message?.is_echo||!e.sender?.id||String(e.recipient?.id)!==String(entry.id))continue;const text=e.message?.text||e.postback?.payload,key=e.message?.mid||e.postback?.mid;if(typeof text!=='string'||typeof key!=='string'||key.length>256)continue;
   const b=await env.DB.prepare("SELECT * FROM reply_bindings WHERE provider='facebook' AND external_id=? AND enabled=1").bind(String(entry.id)).first();if(b)await enqueue(env,b,{key,remote:String(e.sender.id),name:'Messenger',text,time:Math.floor(Number(e.timestamp)/1000)});
  }
 }
 const work=runPendingReplies(env);if(ctx.waitUntil)ctx.waitUntil(work);else await work;return json({ok:true});
}
async function processEvent(env,event){
 const db=env.DB,t=now(),claim=await db.prepare("UPDATE reply_events SET status='processing',updated_at=? WHERE id=? AND status='queued'").bind(t,event.id).run();if(claim.meta.changes!==1)return;
 let started=false,locked=false;
 const finish=(status,code=null,name=null)=>db.prepare('UPDATE reply_events SET status=?,error_code=?,script_name=?,updated_at=? WHERE id=?').bind(status,code,name,now(),event.id).run();
 try{
  const b=await db.prepare('SELECT * FROM reply_bindings WHERE account_id=? AND shop_id=?').bind(event.account_id,event.shop_id).first();
  const c=b&&b.credential===event.credential&&await live(db,b);if(!c)return await finish('skipped','channel_inactive');
  const lock=await db.prepare('UPDATE reply_conversations SET processing_event=? WHERE id=? AND processing_event IS NULL').bind(event.id,event.conversation_id).run();
  if(lock.meta.changes!==1)return await finish('queued');locked=true;
  const v=await db.prepare('SELECT * FROM reply_conversations WHERE id=? AND shop_id=?').bind(event.conversation_id,event.shop_id).first(),e=JSON.parse(event.payload);
  const previous=await db.prepare("SELECT COUNT(*) AS n FROM reply_messages WHERE conversation_id=? AND author='customer'").bind(v.id).first();
  await db.batch([
   db.prepare("INSERT OR IGNORE INTO reply_messages(id,conversation_id,event_id,author,text,created_at) VALUES(?,?,?,'customer',?,?)").bind(uid('rm_'),v.id,event.id,e.text,e.time),
   db.prepare('UPDATE reply_conversations SET last_message_at=?,last_message=? WHERE id=? AND last_message_at<=?').bind(e.time,e.text,v.id,e.time)
  ]);
  if(e.time<now()-86400)return await finish('skipped','response_window_expired');
  const config=await db.prepare('SELECT document,revision FROM reply_configs WHERE shop_id=?').bind(event.shop_id).first();if(!config)return await finish('skipped','config_missing');
  const d=JSON.parse(config.document),hit=matchReply(d.scripts,d.settings,{text:e.text,name:e.name,provider:c.provider,now:Date.now(),firstMessage:previous.n===0,paused:!!v.paused||v.status!=='open'});if(!hit)return await finish('skipped','no_match');
  if(hit.text.length>(c.provider==='facebook'?2000:4096))return await finish('failed','response_too_long',hit.scriptName);
  const token=await decryptToken(env,c.token,c.token_iv);
  const currentConfig=await db.prepare('SELECT revision FROM reply_configs WHERE shop_id=?').bind(event.shop_id).first(),state=await db.prepare('SELECT paused,status FROM reply_conversations WHERE id=?').bind(v.id).first();
  if(!await live(db,b)||currentConfig?.revision!==config.revision||!state||state.paused||state.status!=='open')return await finish('skipped','state_changed');
  const action=hit.extraAction?.action||hit.action;
  if(action==='handoff'||action==='close')await db.prepare('UPDATE reply_conversations SET paused=?,status=? WHERE id=?').bind(action==='handoff'?1:v.paused,action==='handoff'?'handoff':'closed',v.id).run();
  // From this point a thrown network/provider error is ambiguous. Never requeue automatically.
  started=true;
  if(c.provider==='telegram')await callTelegram(token,'sendMessage',{chat_id:c.external_id,text:hit.text,reply_parameters:{message_id:e.messageId,allow_sending_without_reply:false},...(hit.quick.length?{reply_markup:{keyboard:[hit.quick.map(text=>({text}))],resize_keyboard:true,one_time_keyboard:true}}:{})});
  else await graph(env,token,encodeURIComponent(c.external_id)+'/messages',{messaging_type:'RESPONSE',recipient:{id:e.remote},message:{text:hit.text,...(hit.quick.length?{quick_replies:hit.quick.map(text=>({content_type:'text',title:text.slice(0,20),payload:text.slice(0,1000)}))}:{})}});
  const tags=JSON.parse(v.tags);if(hit.action==='tag'&&hit.tagName&&!tags.includes(hit.tagName))tags.push(hit.tagName);
  await db.batch([
   db.prepare("INSERT OR IGNORE INTO reply_messages(id,conversation_id,event_id,author,text,script_name,created_at) VALUES(?,?,?,'bot',?,?,?)").bind(uid('rm_'),v.id,event.id,hit.text,hit.scriptName,now()),
   db.prepare('UPDATE reply_conversations SET paused=CASE WHEN ?=\'handoff\' THEN 1 ELSE paused END,status=CASE WHEN ?=\'handoff\' THEN \'handoff\' WHEN ?=\'close\' THEN \'closed\' ELSE status END,tags=? WHERE id=?').bind(action,action,action,JSON.stringify(tags.slice(0,20)),v.id),
   db.prepare("UPDATE reply_events SET status='sent',script_name=?,updated_at=? WHERE id=?").bind(hit.scriptName,now(),event.id)
  ]);
 }catch{await finish(started?'unknown':'failed',started?'delivery_uncertain':'processing_failed');}
 finally{if(locked)await db.prepare('UPDATE reply_conversations SET processing_event=NULL WHERE id=? AND processing_event=?').bind(event.conversation_id,event.id).run();}
}
export async function runPendingReplies(env){
 if(!env.DB)return {processed:0};await ensureMessagingSchema(env.DB);
 await env.DB.prepare("UPDATE reply_events SET status='unknown',error_code='processing_interrupted',updated_at=? WHERE status='processing' AND updated_at<?").bind(now(),now()-300).run();
 await env.DB.prepare("UPDATE reply_conversations SET processing_event=NULL WHERE processing_event IN (SELECT id FROM reply_events WHERE status='unknown')").run();
 const {results}=await env.DB.prepare("SELECT * FROM reply_events WHERE status='queued' ORDER BY created_at,rowid LIMIT 50").all();for(const e of results)await processEvent(env,e);return {processed:results.length};
}
