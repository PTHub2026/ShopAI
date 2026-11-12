import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {webcrypto,createHmac,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {ensureMessagingSchema,handleReplyWebhook,runPendingReplies,handleMessaging} from '../src/reply-messaging.js';
import {encryptToken} from '../src/social.js';
import {ensureShopSchema} from '../src/shops.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const sec=()=>Math.floor(Date.now()/1000),origin='https://shop.test';
async function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 for(const f of ['0001_drafts.sql','0002_auth.sql'])sqlite.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
 const statement=(sql,args=[])=>({bind:(...a)=>statement(sql,a),async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){return this.exec();},exec(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};}});
 const DB={prepare:s=>statement(s),async batch(stmts){sqlite.exec('BEGIN');try{const r=stmts.map(s=>s.exec());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const env={DB,SOCIAL_TOKEN_KEY:Buffer.alloc(32,7).toString('base64'),PUBLIC_ORIGIN:origin,META_APP_SECRET:'meta-test-secret',META_REPLY_VERIFY_TOKEN:'verify',AI_RATE_LIMITER:{limit:async()=>({success:true})}};
 await ensureShopSchema(DB);await ensureMessagingSchema(DB);
 for(const [shop,owner] of [['s_testshop1','owner1'],['s_testshop2','owner2']]){
  sqlite.prepare('INSERT INTO shops(id,name,owner,status,created_at,updated_at) VALUES(?,?,?,\'active\',?,?)').run(shop,shop,owner,sec(),sec());
  sqlite.prepare('INSERT INTO shop_members(shop_id,user_id,role,can_publish,created_at) VALUES(?,?,\'owner\',1,?)').run(shop,owner,sec());
 }
 const encrypted=await encryptToken(env,'123456789:fake_test_token');
 sqlite.prepare("INSERT INTO channels(id,shop_id,provider,name,external_id,token,token_iv,status) VALUES('a','s_testshop1','telegram','Chat','-123456',?,?,'connected')").run(encrypted.cipher,encrypted.iv);
 const credential=createHash('sha256').update(['telegram','-123456',encrypted.cipher,encrypted.iv].join('\0')).digest('hex');
 sqlite.prepare("INSERT INTO reply_bindings(account_id,shop_id,provider,external_id,bot_id,credential,enabled,updated_at) VALUES('a','s_testshop1','telegram','-123456','123456789',?,1,?)").run(credential,sec());
 const doc={settings:{brand:'Shop',signup:'',open:8,close:22,slaMin:15,timeZone:'Asia/Ho_Chi_Minh'},scripts:[{id:'s',name:'Support',priority:1,on:true,trigger:'fallback',keywords:'',reply:'Hello {ten}',quick:'',action:'none',tagName:'',channels:['telegram']}]};
 sqlite.prepare("INSERT INTO reply_configs VALUES('s_testshop1',?,1,'owner1',?)").run(JSON.stringify(doc),sec());
 const secret=createHmac('sha256',env.SOCIAL_TOKEN_KEY).update('reply-telegram:123456789').digest('hex');
 const inbound=(id=1,change={})=>({update_id:id,message:{message_id:id,date:sec(),chat:{id:-123456,type:'group'},from:{id:55,first_name:'Test'},text:'hello',...change}});
 const webhook=async(body,header=secret)=>handleReplyWebhook(new Request(origin+'/webhooks/replies/telegram/123456789',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':header},body:JSON.stringify(body)}),env);
 const api=(path,method='GET',body,owner='owner1',shop='s_testshop1')=>handleMessaging(new Request(origin+'/api/replies/'+path,{method,headers:{Origin:origin,'X-ShopPost-Shop':shop,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env,{owner},(v,s=200)=>new Response(JSON.stringify(v),{status:s}));
 return {env,sqlite,doc,inbound,webhook,api};
}
async function mockFetch(fn,work){const old=globalThis.fetch;globalThis.fetch=fn;try{return await work();}finally{globalThis.fetch=old;}}
const ok=result=>new Response(JSON.stringify({ok:true,result}),{headers:{'Content-Type':'application/json'}});
test('webhook authentication fails before any event is persisted',async()=>{const f=await fixture();try{
 assert.equal((await f.webhook(f.inbound(),'wrong')).status,403);
 const raw=JSON.stringify({object:'page',entry:[]});
 const r=await handleReplyWebhook(new Request(origin+'/webhooks/replies/meta',{method:'POST',headers:{'X-Hub-Signature-256':'sha256='+'0'.repeat(64)},body:raw}),f.env);
 assert.equal(r.status,403);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM reply_events').get().n,0);
}finally{f.sqlite.close();}});
test('real SQLite deduplication sends once to connected Telegram chat',async()=>{const f=await fixture();try{let sent=[];await mockFetch(async(url,options)=>{assert.match(url,/\/sendMessage$/);sent.push(JSON.parse(options.body));return ok({message_id:9});},async()=>{
 assert.equal((await f.webhook(f.inbound())).status,200);await f.webhook(f.inbound());await runPendingReplies(f.env);
 });assert.equal(sent.length,1);assert.equal(sent[0].chat_id,'-123456');assert.equal(sent[0].reply_parameters.message_id,1);assert.equal(sent[0].text,'Hello Test');assert.equal(f.sqlite.prepare('SELECT status FROM reply_events').get().status,'sent');assert.equal(f.sqlite.prepare('SELECT count(*) n FROM reply_messages').get().n,2);
}finally{f.sqlite.close();}});
test('disabled, revoked and reconnected credentials cannot dispatch; old and bot events ignored',async()=>{const f=await fixture();try{await mockFetch(()=>{throw Error('must not send');},async()=>{
 await f.webhook(f.inbound(1,{date:sec()-86401}));await f.webhook(f.inbound(2,{from:{is_bot:true}}));
 f.sqlite.exec('UPDATE reply_bindings SET enabled=0');await f.webhook(f.inbound(3));f.sqlite.exec("UPDATE reply_bindings SET enabled=1;UPDATE channels SET status='revoked'");await f.webhook(f.inbound(4));f.sqlite.exec("UPDATE channels SET status='connected',token='changed'");await f.webhook(f.inbound(5));
 });assert.equal(f.sqlite.prepare('SELECT count(*) n FROM reply_events').get().n,0);
}finally{f.sqlite.close();}});
test('handoff pauses subsequent messages and shop API isolates conversations',async()=>{const f=await fixture();try{f.doc.scripts[0].action='handoff';f.sqlite.prepare('UPDATE reply_configs SET document=?').run(JSON.stringify(f.doc));let sent=0;await mockFetch(async()=>{sent++;return ok({});},async()=>{await f.webhook(f.inbound(1));await f.webhook(f.inbound(2));});assert.equal(sent,1);
 const c=f.sqlite.prepare('SELECT * FROM reply_conversations').get();assert.equal(c.paused,1);assert.equal(c.status,'handoff');assert.equal((await f.api('conversations/'+c.id,'GET',null,'owner2','s_testshop2')).status,404);assert.equal((await f.api('conversations/'+c.id,'PATCH',{paused:false},'owner2','s_testshop2')).status,404);
 const view=await (await f.api('conversations/'+c.id)).json();assert.equal(view.messages.length,3);assert.equal(view.messages[0].from,'customer');
}finally{f.sqlite.close();}});
test('uncertain delivery and stale processing never retry automatically',async()=>{const f=await fixture();try{let sent=0;await mockFetch(async()=>{sent++;throw Error('timeout');},async()=>{await f.webhook(f.inbound(1));await f.webhook(f.inbound(1));await runPendingReplies(f.env);});assert.equal(sent,1);assert.equal(f.sqlite.prepare('SELECT status FROM reply_events').get().status,'unknown');
 f.sqlite.exec("UPDATE reply_events SET status='processing',updated_at=0");await runPendingReplies(f.env);assert.equal(f.sqlite.prepare('SELECT status,error_code FROM reply_events').get().status,'unknown');
}finally{f.sqlite.close();}});
test('channel activation rejects another webhook and leaves inactive; reads expose no credentials',async()=>{const f=await fixture();try{await mockFetch(async url=>url.endsWith('/getMe')?ok({id:123456789,is_bot:true}):url.endsWith('/getChat')?ok({id:-123456,type:'group'}):ok({url:'https://elsewhere.test/webhook'}),async()=>{const r=await f.api('channels/a','PATCH',{enabled:true});assert.equal(r.status,422);assert.equal((await r.json()).code,'telegram_webhook_owned_elsewhere');});assert.equal(f.sqlite.prepare('SELECT enabled FROM reply_bindings').get().enabled,0);const text=await (await f.api('channels')).text();assert.doesNotMatch(text,/token|credential|cipher/);
}finally{f.sqlite.close();}});
test('signed Meta echoes and wrong recipient are ignored and invalid signature is rejected',async()=>{const f=await fixture();try{
 const post=async body=>{const raw=JSON.stringify(body),sig=createHmac('sha256',f.env.META_APP_SECRET).update(raw).digest('hex');return handleReplyWebhook(new Request(origin+'/webhooks/replies/meta',{method:'POST',headers:{'X-Hub-Signature-256':'sha256='+sig},body:raw}),f.env);};
 const r=await post({object:'page',entry:[{id:'page1',messaging:[{sender:{id:'sender'},recipient:{id:'page1'},timestamp:Date.now(),message:{mid:'m1',is_echo:true,text:'echo'}},{sender:{id:'sender'},recipient:{id:'another'},timestamp:Date.now(),message:{mid:'m2',text:'wrong'}}]}]});assert.equal(r.status,200);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM reply_events').get().n,0);
 assert.equal((await handleReplyWebhook(new Request(origin+'/webhooks/replies/meta?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=challenge'),f.env)).status,200);
 assert.equal((await handleReplyWebhook(new Request(origin+'/webhooks/replies/meta?hub.mode=subscribe&hub.verify_token=wrong'),f.env)).status,403);
}finally{f.sqlite.close();}});
test('disabled script and oversized response never call provider',async()=>{const f=await fixture();try{await mockFetch(()=>{throw Error('must not send');},async()=>{
 f.doc.scripts[0].on=false;f.sqlite.prepare('UPDATE reply_configs SET document=?').run(JSON.stringify(f.doc));await f.webhook(f.inbound(1));assert.equal(f.sqlite.prepare('SELECT status FROM reply_events').get().status,'skipped');
 f.doc.scripts[0].on=true;f.doc.scripts[0].reply='x'.repeat(4097);f.sqlite.prepare('UPDATE reply_configs SET document=?,revision=2').run(JSON.stringify(f.doc));await f.webhook(f.inbound(2));assert.equal(f.sqlite.prepare("SELECT error_code FROM reply_events WHERE event_key='2'").get().error_code,'response_too_long');
 });
}finally{f.sqlite.close();}});
test('disabling after durable webhook enqueue blocks later dispatch',async()=>{const f=await fixture();try{let pending;const raw=JSON.stringify(f.inbound()),secret=createHmac('sha256',f.env.SOCIAL_TOKEN_KEY).update('reply-telegram:123456789').digest('hex');
 // Holding the conversation lock models an existing worker; persisted work stays queued for recovery.
 const cid='rc_'+createHash('sha256').update('a\0-123456').digest('hex');f.sqlite.prepare("INSERT INTO reply_conversations(id,shop_id,account_id,remote_id,name,last_message_at,last_message,processing_event) VALUES(?,'s_testshop1','a','-123456','Test',?,'hello','held')").run(cid,sec());
 await handleReplyWebhook(new Request(origin+'/webhooks/replies/telegram/123456789',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':secret},body:raw}),f.env,{waitUntil:p=>{pending=p;}});await pending;
 assert.equal(f.sqlite.prepare('SELECT status FROM reply_events').get().status,'queued');f.sqlite.exec('UPDATE reply_bindings SET enabled=0;UPDATE reply_conversations SET processing_event=NULL');
 await mockFetch(()=>{throw Error('must not send');},()=>runPendingReplies(f.env));assert.equal(f.sqlite.prepare('SELECT status FROM reply_events').get().status,'skipped');
}finally{f.sqlite.close();}});
test('private conversation RBAC limits support to assignments and denies content/viewer',async()=>{const f=await fixture();try{
 for(const [user,role] of [['support1','support'],['support2','support'],['writer','content'],['viewer','viewer']])f.sqlite.prepare('INSERT INTO shop_members(shop_id,user_id,role,can_publish,created_at) VALUES(?,?,?,0,?)').run('s_testshop1',user,role,sec());
 await mockFetch(async()=>ok({}),()=>f.webhook(f.inbound()));const c=f.sqlite.prepare('SELECT id FROM reply_conversations').get();
 for(const owner of ['writer','viewer']){assert.equal((await f.api('conversations','GET',null,owner)).status,403);assert.equal((await f.api('conversations/'+c.id,'GET',null,owner)).status,403);}
 assert.deepEqual((await (await f.api('conversations','GET',null,'support1')).json()).conversations,[]);assert.equal((await f.api('conversations/'+c.id,'GET',null,'support1')).status,404);
 assert.equal((await f.api('conversations/'+c.id,'PATCH',{assignedTo:'support1'})).status,200);
 assert.equal((await (await f.api('conversations','GET',null,'support1')).json()).conversations.length,1);
 assert.equal((await f.api('conversations/'+c.id,'GET',null,'support1')).status,200);assert.equal((await f.api('conversations/'+c.id,'PATCH',{paused:true},'support2')).status,404);
 assert.equal((await f.api('conversations/'+c.id,'PATCH',{assignedTo:'support2'},'support1')).status,403);
 assert.equal((await f.api('conversations/'+c.id,'PATCH',{assignedTo:'writer'})).status,400);
 assert.equal((await f.api('conversations/'+c.id,'PATCH',{assignedTo:'owner2'})).status,400);
}finally{f.sqlite.close();}});
test('metrics reports real zero and populated response timings without message content',async()=>{const f=await fixture();try{
 let m=await (await f.api('metrics?days=7')).json();assert.equal(m.inboundMessages,0);assert.equal(m.firstReplyAverageSeconds,null);assert.equal(m.firstReplyP90Seconds,null);
 await mockFetch(async()=>ok({}),()=>f.webhook(f.inbound()));m=await (await f.api('metrics?days=7')).json();assert.equal(m.inboundMessages,1);assert.equal(m.outboundMessages,1);assert.equal(m.respondedConversations,1);assert.equal(m.slaMet,1);assert.equal(m.slaMinutes,15);assert.equal(m.conversations,1);assert.ok(m.firstReplyAverageSeconds>=0);assert.ok(m.firstReplyP90Seconds>=0);assert.equal(JSON.stringify(m).includes('Hello'),false);
 f.sqlite.prepare("INSERT INTO shop_members(shop_id,user_id,role,can_publish,created_at) VALUES('s_testshop1','support','support',0,?)").run(sec());assert.equal((await f.api('metrics','GET',null,'support')).status,403);
 assert.equal((await f.api('metrics?days=5')).status,400);
}finally{f.sqlite.close();}});
test('one provider target cannot activate in a second shop',async()=>{const f=await fixture();try{
 const c=f.sqlite.prepare("SELECT * FROM channels WHERE id='a'").get();f.sqlite.prepare("INSERT INTO channels(id,shop_id,provider,name,external_id,token,token_iv,status) VALUES('second','s_testshop2','telegram','Duplicate','-123456',?,?,'connected')").run(c.token,c.token_iv);
 await mockFetch(()=>{throw Error('no external mutation before uniqueness');},async()=>{const r=await f.api('channels/second','PATCH',{enabled:true},'owner2','s_testshop2');assert.equal(r.status,409);assert.equal((await r.json()).code,'target_already_active');});
}finally{f.sqlite.close();}});
test('signed Facebook message uses RESPONSE and exact page recipient binding',async()=>{const f=await fixture();try{
 f.doc.scripts[0].channels=['facebook'];f.sqlite.prepare('UPDATE reply_configs SET document=?').run(JSON.stringify(f.doc));
 const c=f.sqlite.prepare("SELECT * FROM channels WHERE id='a'").get();f.sqlite.prepare("INSERT INTO channels(id,shop_id,provider,name,external_id,token,token_iv,status) VALUES('fb','s_testshop1','facebook','Page','page123',?,?,'connected')").run(c.token,c.token_iv);
 const fp=createHash('sha256').update(['facebook','page123',c.token,c.token_iv].join('\0')).digest('hex');f.sqlite.prepare("INSERT INTO reply_bindings(account_id,shop_id,provider,external_id,bot_id,credential,enabled,updated_at) VALUES('fb','s_testshop1','facebook','page123','',?,1,?)").run(fp,sec());
 const body={object:'page',entry:[{id:'page123',messaging:[{sender:{id:'customer123'},recipient:{id:'page123'},timestamp:Date.now(),message:{mid:'meta-message-1',text:'Hello'}}]}]},raw=JSON.stringify(body),sig=createHmac('sha256',f.env.META_APP_SECRET).update(raw).digest('hex');let sent=0;
 await mockFetch(async(url,options)=>{assert.match(url,/v26\.0\/page123\/messages$/);const message=JSON.parse(options.body);assert.equal(message.messaging_type,'RESPONSE');assert.equal(message.recipient.id,'customer123');assert.equal(message.message.text,'Hello Messenger');sent++;return new Response(JSON.stringify({message_id:'reply1'}));},async()=>{
 const req=()=>new Request(origin+'/webhooks/replies/meta',{method:'POST',headers:{'X-Hub-Signature-256':'sha256='+sig},body:raw});assert.equal((await handleReplyWebhook(req(),f.env)).status,200);await handleReplyWebhook(req(),f.env);
 });assert.equal(sent,1);
}finally{f.sqlite.close();}});
test('configuration replaced during processing blocks stale reply before send',async()=>{const f=await fixture();try{
 const original=f.env.DB.prepare;let changed=false;f.env.DB.prepare=sql=>{const stmt=original(sql);if(sql==='SELECT document,revision FROM reply_configs WHERE shop_id=?'){const bind=stmt.bind;stmt.bind=(...args)=>{const bound=bind(...args),first=bound.first;bound.first=async()=>{const snapshot=await first.call(bound);if(!changed){changed=true;f.doc.scripts[0].reply='New reply';f.sqlite.prepare('UPDATE reply_configs SET document=?,revision=revision+1').run(JSON.stringify(f.doc));}return snapshot;};return bound;};}return stmt;};
 await mockFetch(()=>{throw Error('stale reply must never send');},()=>f.webhook(f.inbound()));assert.equal(changed,true);const e=f.sqlite.prepare('SELECT status,error_code FROM reply_events').get();assert.equal(e.status,'skipped');assert.equal(e.error_code,'state_changed');
}finally{f.sqlite.close();}});
test('disable during Telegram verification prevents setWebhook mutation',async()=>{const f=await fixture();try{let mutations=0;await mockFetch(async url=>{
 if(url.endsWith('/getMe'))return ok({id:123456789,is_bot:true});if(url.endsWith('/getChat'))return ok({id:-123456,type:'group'});if(url.endsWith('/getWebhookInfo')){f.sqlite.exec('UPDATE reply_bindings SET enabled=0');return ok({url:''});}mutations++;return ok(true);
 },async()=>{const r=await f.api('channels/a','PATCH',{enabled:true});assert.equal(r.status,422);assert.equal((await r.json()).code,'channel_disabled');});assert.equal(mutations,0);assert.equal(f.sqlite.prepare('SELECT enabled FROM reply_bindings').get().enabled,0);
}finally{f.sqlite.close();}});
test('authenticated payloads enforce byte and event limits before persistence',async()=>{const f=await fixture();try{
 assert.equal((await f.webhook(f.inbound(1,{text:'x'.repeat(1048577)}))).status,400);
 const body={object:'page',entry:[{id:'page',messaging:Array.from({length:51},(_,i)=>({sender:{id:'s'},recipient:{id:'page'},timestamp:Date.now(),message:{mid:String(i),text:'hi'}}))}]},raw=JSON.stringify(body),sig=createHmac('sha256',f.env.META_APP_SECRET).update(raw).digest('hex');
 const response=await handleReplyWebhook(new Request(origin+'/webhooks/replies/meta',{method:'POST',headers:{'X-Hub-Signature-256':'sha256='+sig},body:raw}),f.env);assert.equal(response.status,400);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM reply_events').get().n,0);
}finally{f.sqlite.close();}});
