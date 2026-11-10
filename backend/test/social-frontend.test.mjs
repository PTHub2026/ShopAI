import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {JSDOM,VirtualConsole} from 'jsdom';
const source=readFileSync(new URL('../../index.html',import.meta.url),'utf8'),scope='a'.repeat(64);
const a='s_aaaaaaaaaa',b='s_bbbbbbbbbb';
const shops={shops:[a,b].map((id,i)=>({id,name:'Shop '+i,role:'owner',permissions:['channels.configure_token','channels.view','drafts.publish']})),defaultShopId:a};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const settle=async()=>{for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));};
function runtime({hash='',shopResponse,handle,session={}}={}){
 const requests=[];
 const html=source.replace('<head>','<head><meta name="shopai-ai-endpoint" content="/ai"><meta name="shopai-user-scope" content="'+scope+'">');
 const dom=new JSDOM(html,{url:'https://app.example/'+hash,runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:new VirtualConsole(),beforeParse(w){
  w.scrollTo=()=>{};w.confirm=()=>true;w.AbortSignal=AbortSignal;w.TextEncoder=TextEncoder;w.crypto.randomUUID=randomUUID;
  w.localStorage.setItem('pdk_shop:'+scope,b);
  for(const [key,value] of Object.entries(session))w.sessionStorage.setItem(key,value);
  w.fetch=async(url,options={})=>{
   const path=new URL(url,w.location.href).pathname,request={path,...options};requests.push(request);
   if(path==='/api/shops')return shopResponse?shopResponse.promise:Response.json(shops);
   if(path.endsWith('/jobs/events'))return new Promise((resolve,reject)=>options.signal?.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));
   const custom=handle?.(request);if(custom)return custom;
   if(path==='/session')return Response.json({userScope:scope,capabilities:{drafts:true}});
   if(path==='/channels')return Response.json({channels:[],setup:{zalo:{}}});
   if(path.endsWith('/providers'))return Response.json({facebook:{enabled:false}});
   if(path.endsWith('/accounts'))return Response.json({accounts:[{id:'account',provider:'telegram',name:'Account',targetId:'target',status:'active'}]});
   return Response.json({jobs:[]});
  };
 }});
 return {w:dom.window,requests,eval:s=>dom.window.eval(s),close(){dom.window.eval('stopJobWatch()');dom.window.close();}};
}
function fill(r,text='First',account='account'){
 assert.ok(r.w.document.querySelector('#tg_account'),r.w.document.querySelector('#view').textContent);
 r.w.document.querySelector('#tg_account').value=account;
 r.w.document.querySelector('#tg_text').value=text;
}
test('social requests carry the embedded account scope',async()=>{
 const r=runtime();try{await settle();await r.eval("socialRequest('jobs')");
  assert.equal(r.requests.find(x=>x.path==='/channels/all/jobs').headers['X-ShopAI-User-Scope'],scope);
 }finally{r.close();}
});
test('completion of a pending disconnect cannot replace a different page with an accounts loader',async()=>{
 const pending=deferred(),r=runtime({handle:q=>q.method==='DELETE'?pending.promise:null});
 try{await settle();r.eval("go('accounts')");await settle();
  const done=r.eval("socialDisconnectTelegram('account')");r.eval("go('settings')");
  const before=r.w.document.querySelector('#view').innerHTML;pending.resolve(Response.json({ok:true}));await done;await settle();
  assert.equal(r.w.document.querySelector('#view').innerHTML,before);
 }finally{pending.resolve(Response.json({ok:true}));r.close();}
});
test('direct accounts landing waits for the saved shop before sending social reads',async()=>{
 const pending=deferred(),r=runtime({hash:'#accounts',shopResponse:pending});
 try{await settle();assert.equal(r.requests.filter(x=>x.path.startsWith('/channels/all/')).length,0);
  pending.resolve(Response.json(shops));await settle();
  const reads=r.requests.filter(x=>['/channels/all/accounts','/channels/all/jobs','/channels/all/providers'].includes(x.path));
  assert.ok(reads.length>=3);for(const q of reads)assert.equal(q.headers['X-ShopPost-Shop'],b);
  assert.ok(r.w.document.querySelector('#tg_text'));
 }finally{pending.resolve(Response.json(shops));r.close();}
});
for(const fail of [false,true])test('stale accounts '+(fail?'errors':'responses')+' cannot overwrite the new shop',async()=>{
 const pending=deferred();let delay=false;
 const r=runtime({handle:q=>q.path.endsWith('/accounts')?delay&&q.headers['X-ShopPost-Shop']===a?pending.promise:Response.json({accounts:[{id:'account',provider:'telegram',name:q.headers['X-ShopPost-Shop'],targetId:'target',status:'active'}]}):null});
 try{await settle();delay=true;r.eval("shopSwitch('"+a+"');go('accounts')");await settle();
  r.eval("shopSwitch('"+b+"')");await settle();
  pending.resolve(fail?Response.json({error:'OLD SHOP ERROR'},{status:500}):Response.json({accounts:[{id:'old',provider:'telegram',name:'OLD SHOP',status:'active'}]}));
  await settle();const content=r.w.document.querySelector('#view').textContent;
  assert.ok(content.includes(b));assert.ok(!content.includes('OLD SHOP'));
 }finally{pending.resolve(Response.json({accounts:[]}));r.close();}
});
test('accounts needing reauthorization keep their disconnect action',async()=>{
 const r=runtime({handle:q=>q.path.endsWith('/accounts')?Response.json({accounts:['active','error','reauth_required','revoked'].map(status=>({id:status,name:status,provider:'telegram',status}))}):null});
 try{await settle();r.eval("go('accounts')");await settle();
  const buttons=[...r.w.document.querySelectorAll('button[onclick^="socialDisconnectTelegram"]')];
  assert.equal(buttons.length,3,r.w.document.querySelector('#view').textContent);assert.ok(!buttons.some(x=>x.getAttribute('onclick').includes('revoked')));
 }finally{r.close();}
});
for(const fail of [false,true])test('an earlier accounts view cannot overwrite a later view in the same shop: '+fail,async()=>{
 const pending=deferred();let delay=false;
 const r=runtime({handle:q=>q.path.endsWith('/accounts')&&delay?pending.promise:null});
 try{
  await settle();delay=true;r.eval("go('accounts')");await settle();
  delay=false;r.eval("go('settings');go('accounts')");await settle();
  const before=r.w.document.querySelector('#view').innerHTML;
  pending.resolve(fail?Response.json({error:'STALE ERROR'},{status:500}):Response.json({accounts:[{id:'stale',name:'STALE ACCOUNT',provider:'telegram',status:'active'}]}));await settle();
  assert.equal(r.w.document.querySelector('#view').innerHTML,before);
 }finally{pending.resolve(Response.json({accounts:[]}));r.close();}
});
test('history retry resolves only its operation and keeps the typed next post',async()=>{
 const keys=[];let publish=0;
 const r=runtime({handle:q=>{
  if(q.path==='/channels/all/jobs'&&q.method==='POST'){keys.push(q.headers['Idempotency-Key']);return ++publish===1?Response.json({job:{id:'job-one',status:'retryable'}},{status:429}):Response.json({job:{id:'job-two',status:'sent',remoteMessageId:'remote'}});}
  if(q.path.endsWith('/job-one/retry'))return Response.json({job:{id:'job-one',status:'sent',remoteMessageId:'remote-one'}});
 }});
 try{await settle();r.eval("go('accounts')");await settle();fill(r);await r.eval('socialPublishTelegram()');
  fill(r,'Next post');await r.eval("socialRetryTelegram('job-one')");await settle();
  assert.equal(r.w.document.querySelector('#tg_text').value,'Next post');
  await r.eval('socialPublishTelegram()');assert.equal(keys.length,2);assert.notEqual(keys[0],keys[1]);
  fill(r,'First');await r.eval('socialPublishTelegram()');assert.notEqual(keys[0],keys[2]);
 }finally{r.close();}
});
test('uncertain operations retain their key while payload and shop changes get separate keys',async()=>{
 const keys=[];
 const r=runtime({handle:q=>{
  if(q.path.endsWith('/accounts'))return Response.json({accounts:['account','second-account'].map(id=>({id,provider:'telegram',name:id,status:'active'}))});
  if(q.path==='/channels/all/jobs'&&q.method==='POST'){keys.push(q.headers['Idempotency-Key']);return Response.json({job:{id:'uncertain-'+keys.length,status:'unknown'}},{status:502});}
 }});
 try{await settle();r.eval("go('accounts')");await settle();fill(r,'Original');await r.eval('socialPublishTelegram()');
  fill(r,'Other');await r.eval('socialPublishTelegram()');fill(r,'Original');await r.eval('socialPublishTelegram()');
  fill(r,'Original','second-account');await r.eval('socialPublishTelegram()');
  r.eval("shopSwitch('"+a+"')");await settle();fill(r,'Original');await r.eval('socialPublishTelegram()');
  assert.equal(keys.length,5);assert.notEqual(keys[0],keys[1]);assert.equal(keys[0],keys[2]);assert.notEqual(keys[0],keys[3]);assert.notEqual(keys[0],keys[4]);
 }finally{r.close();}
});
test('an uncertain publish retains its idempotency key across a tab reload',async()=>{
 const keys=[],handle=q=>{if(q.path==='/channels/all/jobs'&&q.method==='POST'){keys.push(q.headers['Idempotency-Key']);return Response.json({job:{id:'unknown-job',status:'unknown'}},{status:502});}};
 const first=runtime({handle});let stored;
 try{await settle();first.eval("go('accounts')");await settle();fill(first);await first.eval('socialPublishTelegram()');stored=Object.fromEntries(Object.entries(first.w.sessionStorage));}finally{first.close();}
 const next=runtime({handle,session:stored});
 try{await settle();next.eval("go('accounts')");await settle();fill(next);await next.eval('socialPublishTelegram()');assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);}finally{next.close();}
});
