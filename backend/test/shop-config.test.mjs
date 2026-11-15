import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sqliteDB} from './sqlite-fixture.mjs';
import {resolveShop} from '../src/shops.js';
import {handleShopConfig} from '../src/shop-config.js';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
test('shop configuration persists, isolates shops and rejects stale revision and unauthorized edits',async()=>{
 const env={DB:sqliteDB()},who={owner:'config-owner',email:'config@example.com'};
 const ctx=await resolveShop(env,who,new Request('https://app.example/'));
 const call=(bucket,body,user=who,shop=ctx.shop.id)=>handleShopConfig(new Request('https://app.example/api/shop-config/'+bucket,{method:body?'PUT':'GET',headers:{'X-ShopPost-Shop':shop,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env,user,(b,status=200)=>Response.json(b,{status}));
 assert.equal((await (await call('settings')).json()).value,null);
 const value={brand:'Alpha',rules:'No invented prices'};
 const first=await call('settings',{revision:null,value});assert.equal(first.status,200);const row=await first.json();
 assert.deepEqual((await (await call('settings')).json()).value,value);
 assert.equal((await call('settings',{revision:null,value})).status,409);
 assert.equal((await call('settings',{revision:row.revision,value:{brand:'Beta'}})).status,200);
 const outsider={owner:'other',email:'other@example.com'};
 assert.equal((await call('settings',null,outsider)).status,404);
 const other=await resolveShop(env,outsider,new Request('https://app.example/'));
 assert.equal((await (await call('settings',null,outsider,other.shop.id)).json()).value,null);
 assert.equal((await call('settings',{revision:null,value:{aiEndpoint:'https://external.example'}})).status,422);
 assert.equal((await call('groups',{revision:null,value:[{id:'g1',name:'Foreign',desc:'',color:'#ffffff',channels:['real_facebook_foreign']}]})).status,422);
 env.DB.sqlite.prepare('UPDATE shop_members SET role = ? WHERE shop_id = ? AND user_id = ?').run('viewer',ctx.shop.id,who.owner);
 assert.equal((await call('hashtags',{revision:null,value:[]})).status,403);
 assert.equal((await call('settings')).status,200);
 env.DB.sqlite.prepare('UPDATE shop_members SET role = ? WHERE shop_id = ? AND user_id = ?').run('support',ctx.shop.id,who.owner);
 assert.equal((await call('settings')).status,200);
 assert.equal((await call('settings',{revision:null,value})).status,403);
 env.DB.sqlite.close();
});
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
function runtime(){let requests=[];const c=vm.createContext({S:{groups:[{id:'old'}],hashtags:[],settings:{brand:'Old'}},localShop:'shop-a',SHOP:{ready:true},managedApp:()=>true,shopCan:()=>true,emptyState:()=>({settings:{}}),$:()=>null,LIBSYNC:{context:{ready:Promise.resolve()}},route:'create',persist:()=>{},toast:()=>{},confirm:()=>true,cloudRequest:(path,options)=>new Promise(resolve=>requests.push({path,options,resolve}))});vm.runInContext(html.slice(html.indexOf('const CONFIG_FIELDS='),html.indexOf('/* ================= CLOUD DRAFTS')),c);return {c,requests};}
test('shop change clears prior settings immediately and discards stale server responses',async()=>{
 const {c,requests}=runtime();c.configActivate();assert.equal(c.S.settings.brand,'');const pending=c.configReload();await new Promise(r=>setImmediate(r));assert.equal(requests.length,3);
 c.localShop='shop-b';c.configActivate();requests.forEach(r=>r.resolve({bucket:r.path.split('/').pop(),revision:'old',value:r.path.endsWith('settings')?{brand:'Leaked'}:[]}));await pending;assert.equal(c.S.settings.brand,'');assert.equal(vm.runInContext('CONFIG.shop',c),'shop-b');
});
test('legacy settings never upload without explicit recovery; conflicts stop automatic retries',async()=>{
 const {c,requests}=runtime();c.configActivate();c.configCapture();assert.equal(requests.length,0);
 const pending=c.configReload();await new Promise(r=>setImmediate(r));requests.forEach(r=>r.resolve({bucket:r.path.split('/').pop(),revision:null,value:null}));await pending;c.configCapture();await new Promise(r=>setImmediate(r));assert.equal(requests.length,3);
 c.cloudRequest=async()=>{throw Error('conflict')};c.S.settings.brand='Edited';c.configCapture();await new Promise(r=>setImmediate(r));assert.match(vm.runInContext('CONFIG.error',c),/conflict/);assert.equal(c.S.settings.brand,'Edited');
});
test('brand falls back to existing chatbot then canonical settings control chatbot preview',async()=>{
 const {handleReplies,ensureReplySchema}=await import('../src/replies.js');
 const env={DB:sqliteDB(),AI_RATE_LIMITER:{limit:async()=>({success:true})}},who={owner:'brand-owner',email:'brand@example.com'};
 const ctx=await resolveShop(env,who,new Request('https://app.example/'));await ensureReplySchema(env.DB);
 const document={scripts:[],settings:{brand:'Legacy brand',signup:'https://old.example',open:8,close:22,slaMin:15,timeZone:'Asia/Ho_Chi_Minh'}};
 await env.DB.prepare('INSERT INTO reply_configs VALUES(?,?,1,?,?)').bind(ctx.shop.id,JSON.stringify(document),who.owner,Date.now()).run();
 const req=(path,body)=>new Request('https://app.example'+path,{method:body?'PUT':'GET',headers:{Origin:'https://app.example','X-ShopPost-Shop':ctx.shop.id,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const json=(b,status=200)=>Response.json(b,{status});
 try{
  const initial=await(await handleShopConfig(req('/api/shop-config/settings'),env,who,json)).json();assert.equal(initial.value.brand,'Legacy brand');
  await handleShopConfig(req('/api/shop-config/settings',{revision:null,value:{brand:'Canonical',signup:'https://new.example'}}),env,who,json);
  const reply=await(await handleReplies(req('/api/replies/config'),env,who,json)).json();assert.equal(reply.settings.brand,'Canonical');assert.equal(reply.settings.signup,'https://new.example');
 }finally{env.DB.sqlite.close();}
});
