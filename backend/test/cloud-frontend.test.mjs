import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
const source=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const scope='a'.repeat(64);
const session={userScope:scope,capabilities:{ai:true,drafts:true,publishing:false,scheduling:false,inbox:false}};
const envelope=(id='cloud-a',content='Đã lưu từ thiết bị khác',revision=1)=>({draft:{id,type:'post',content,channels:[],status:'draft',media:[],assets:[],custom:{}},revision,updatedAt:1000});
function runtime({managed=true,fetchImpl,stored={}}={}) {
  const requests=[],errors=[];
  const html=managed?source.replace('<head>','<head><meta name="shopai-ai-endpoint" content="/ai"><meta name="shopai-user-scope" content="'+scope+'">'):source;
  const dom=new JSDOM(html,{url:'https://app.example/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:new VirtualConsole(),beforeParse(w){
    w.scrollTo=()=>{};w.AbortSignal=AbortSignal;w.TextEncoder=TextEncoder;
    for(const [k,v] of Object.entries(stored))w.localStorage.setItem(k,JSON.stringify(v));
    w.fetch=async(url,options={})=>{const path=new URL(url,w.location.href).pathname;requests.push({path,...options});return fetchImpl?fetchImpl(path,options):Response.json(session)};
    w.addEventListener('error',e=>errors.push(e.error));
  }});
  const w=dom.window;
  return {dom,w,requests,errors,read:s=>w.eval(s),close:()=>w.close()};
}
const settle=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
function edit(r,text='Bản nháp cần lưu') {r.w.document.querySelector('#ct').value=text;r.w.document.querySelector('#ct').dispatchEvent(new r.w.Event('input'));}

test('Managed application starts empty and separates local state from demo',async()=>{
  const r=runtime();try{
    await settle();assert.deepEqual(r.errors,[]);
    assert.equal(r.read('S.posts.length'),0);assert.equal(r.read('S.channels.length'),0);assert.equal(r.read('S.convos.length'),0);
    assert.ok(r.w.document.querySelector('#cloud_save'));
    edit(r,'Nháp của Alice');
    assert.equal(JSON.parse(r.w.localStorage.getItem('pdk_draft_v1:'+scope)).content,'Nháp của Alice');
    assert.equal(r.w.localStorage.getItem('pdk_draft_v1'),null);
  } finally {r.close()}
});

test('Cloud save is explicit, reuses revisions, and leaves local editor intact',async()=>{
  let revision=0;
  const r=runtime({fetchImpl:async(path,options)=>{
    if(path==='/session')return Response.json(session);
    assert.equal(path,'/storage/drafts/'+JSON.parse(options.body).draft.id);
    assert.equal(options.headers['X-ShopAI-User-Scope'],scope);
    assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'error');
    const body=JSON.parse(options.body);assert.equal(body.revision,revision);
    return Response.json({...envelope(body.draft.id,body.draft.content,++revision),draft:body.draft});
  }});
  try {
    await settle();assert.ok(!r.requests.some(x=>x.method==='PUT'));
    edit(r);await r.w.cloudSaveDraft();assert.equal(revision,1);
    assert.equal(r.read('D.content'),'Bản nháp cần lưu');assert.equal(r.read('D.cloud.revision'),1);
    edit(r,'Nội dung mới');await r.w.cloudSaveDraft();assert.equal(revision,2);
  } finally {r.close()}
});

test('Cloud failures never erase the local draft or confirm a save',async()=>{
  for(const response of [new Response('{"error":"Phiên hết hạn"}',{status:401,headers:{'content-type':'application/json'}}),new Response('<html>Login</html>',{headers:{'content-type':'text/html'}}),new Response('{"error":"DB unavailable"}',{status:503,headers:{'content-type':'application/json'}}),Response.json({})]){
    const r=runtime({fetchImpl:async path=>path==='/session'?Response.json(session):response});
    try {edit(r);await r.w.cloudSaveDraft();assert.equal(r.read('D.content'),'Bản nháp cần lưu');assert.equal(r.read('!!D.cloud'),false);assert.match(r.w.document.querySelector('#cloud_status').textContent,/chưa|không|hết hạn|unavailable|hợp lệ/i);}finally{r.close()}
  }
});

test('Conflicts retain the original revision and allow an explicit new copy',async()=>{
  let calls=0;
  const r=runtime({fetchImpl:async(path,options)=>{
    if(path==='/session')return Response.json(session);
    if(++calls===1)return Response.json({error:'Bản nháp đã thay đổi'},{status:409});
    const body=JSON.parse(options.body);assert.equal(body.revision,0);assert.notEqual(body.draft.id,'old');
    return Response.json({...envelope(body.draft.id,body.draft.content),draft:body.draft});
  }});
  try{
    edit(r);r.read('D.cloud={id:"old",revision:2,scope:APP_SCOPE}');
    await r.w.cloudSaveDraft();assert.equal(r.read('D.cloud.revision'),2);
    await r.w.cloudSaveDraft(true);assert.equal(r.read('D.cloud.revision'),1);
  }finally{r.close()}
});

test('A pending save cannot overwrite edits or a replacement draft',async()=>{
  for(const replace of [false,true]){
    const pending=deferred();
    const r=runtime({fetchImpl:async(path,options)=>path==='/session'?Response.json(session):pending.promise.then(()=>{const body=JSON.parse(options.body);return Response.json({...envelope(body.draft.id,body.draft.content),draft:body.draft})})});
    try{
      edit(r,'Bản gửi lên server');const saving=r.w.cloudSaveDraft();await settle();
      if(replace)r.read('D=newDraft()');edit(r,'Nội dung mới chưa lưu');
      pending.resolve();await saving;
      assert.equal(r.read('D.content'),'Nội dung mới chưa lưu');
      assert.equal(r.read('!!D.cloud'),!replace);
    }finally{r.close()}
  }
});

test('Unsupported media, custom content or schedules do not get silently dropped',async()=>{
  for(const change of ['D.media=[{type:"image/png"}]','D.custom={x:{text:"riêng"}}','D.textAssets=["a"]','D.when="later"']){
    const r=runtime();try{await settle();edit(r);r.read(change);await r.w.cloudSaveDraft();assert.equal(r.requests.filter(x=>x.method==='PUT').length,0);assert.equal(r.read('!!D.cloud'),false)}finally{r.close()}
  }
});

test('Opening a cloud draft uses the latest server revision and protects unsaved edits',async()=>{
  const r=runtime({fetchImpl:async path=>path==='/session'?Response.json(session):path==='/storage/drafts'?Response.json({drafts:[envelope()],nextCursor:null}):Response.json(envelope('cloud-a','Nội dung máy chủ',3))});
  try{
    await r.w.cloudListDrafts();assert.match(r.w.document.querySelector('#mbox').textContent,/Đã lưu từ thiết bị khác/);
    await r.w.cloudOpenDraft('cloud-a');assert.equal(r.read('D.content'),'Nội dung máy chủ');assert.equal(r.read('D.cloud.revision'),3);
    edit(r,'Giữ bản mới');await r.w.cloudOpenDraft('cloud-a');
    assert.equal(r.read('D.content'),'Giữ bản mới');
    r.w.document.querySelector('#ask_yes').click();assert.equal(r.read('D.content'),'Nội dung máy chủ');
  }finally{r.close()}
});

test('Account changes and QA cannot upload drafts',async()=>{
  for(const qa of [false,true]){
    const r=runtime({fetchImpl:async()=>Response.json({...session,userScope:'b'.repeat(64)})});
    try{edit(r);r.w.QA_RUNNING=qa;await r.w.cloudSaveDraft();assert.equal(r.requests.filter(x=>x.method==='PUT').length,0);assert.equal(r.read('!!D.cloud'),false)}finally{r.close()}
  }
});

test('Managed runtime never publishes, connects channels, sends messages or invents metrics',async()=>{
  const r=runtime();try{
    r.read('S.channels=[{id:"c1",pf:"facebook",connected:false}];S.posts=[{id:"p1",status:"scheduled",time:0,channels:["c1"],metrics:{c1:{views:1,likes:0,comments:0,shares:0}}}];S.convos=[{id:"cv1",messages:[],tags:[]}];');
    r.w.setConn('c1',true);assert.equal(r.read('S.channels[0].connected'),false);
    r.w.tick();assert.equal(r.read('S.posts[0].status'),'scheduled');
    r.w.pubNow('p1');assert.equal(r.read('S.posts[0].status'),'scheduled');
    r.w.syncMetrics();assert.equal(r.read('S.posts[0].metrics.c1.views'),1);
    r.w.sendMsg('cv1');assert.equal(r.read('S.convos[0].messages.length'),0);
  }finally{r.close()}
});

test('Offline demo remains available and never enables cloud storage',async()=>{
  const r=runtime({managed:false});try{
    assert.deepEqual(r.errors,[]);assert.ok(r.read('S.posts.length')>0);assert.ok(r.read('S.channels.length')>0);
    edit(r);assert.equal(typeof r.w.cloudSaveDraft,'function');await r.w.cloudSaveDraft();assert.equal(r.requests.length,0);
  }finally{r.close()}
});

test('A text-only video draft keeps its type when saved again',async()=>{
  const r=runtime({fetchImpl:async(path,options)=>{
    if(path==='/session')return Response.json(session);
    if(options.method!=='PUT')return Response.json({...envelope(),draft:{...envelope().draft,type:'video'}});
    const body=JSON.parse(options.body);assert.equal(body.draft.type,'video');
    return Response.json({...envelope(body.draft.id,body.draft.content,2),draft:body.draft});
  }});
  try{await r.w.cloudOpenDraft('cloud-a');await r.w.cloudSaveDraft();assert.equal(r.read('D.cloud.revision'),2)}finally{r.close()}
});

test('Delayed cloud loading cannot replace a draft edited while loading',async()=>{
  const pending=deferred();
  const r=runtime({fetchImpl:async path=>path==='/session'?Response.json(session):pending.promise.then(()=>Response.json(envelope()))});
  try{
    const opening=r.w.cloudOpenDraft('cloud-a');await settle();edit(r,'Đang viết nội dung khác');pending.resolve();await opening;
    assert.equal(r.read('D.content'),'Đang viết nội dung khác');assert.equal(r.read('!!D.cloud'),false);
  }finally{r.close()}
});

test('Managed feedback identity never reads or overwrites global/demo contact caches',async()=>{
  const r=runtime();try{
    r.w.localStorage.setItem('pdk_fb_by','Account A');r.w.localStorage.setItem('pdk_fb_email','a@example.com');
    r.w.fbQuick();assert.equal(r.w.document.querySelector('#fb_by').value,'');assert.equal(r.w.document.querySelector('#fb_email').value,'');
    for(const [id,value] of Object.entries({fb_by:'Account B',fb_email:'b@example.com',fb_title:'Đề xuất cá nhân',fb_desc:'Nội dung góp ý thử nghiệm'}))r.w.document.querySelector('#'+id).value=value;
    r.w.fbSubmit(true);
    assert.equal(r.w.localStorage.getItem('pdk_fb_by:'+scope),'Account B');assert.equal(r.w.localStorage.getItem('pdk_fb_email:'+scope),'b@example.com');
    assert.equal(r.w.localStorage.getItem('pdk_fb_email'),'a@example.com');
    r.w.fbQuick();r.w.document.querySelector('#fb_title').value='Góp ý trong QA';r.w.document.querySelector('#fb_desc').value='Kiểm tra bảo toàn danh tính';r.w.document.querySelector('#fb_email').value='qa@example.com';
    r.w.QA_RUNNING=true;r.w.fbSubmit(true);assert.equal(r.w.localStorage.getItem('pdk_fb_email:'+scope),'b@example.com');
  }finally{r.close()}
});

test('A delayed draft list cannot reopen after navigation or dismissing the list',async()=>{
  for(const dismiss of [false,true]){
    const pending=deferred();let count=0;
    const r=runtime({fetchImpl:async path=>{
      if(path==='/session')return Response.json(session);
      if(dismiss&&++count===1)return Response.json({drafts:[envelope()],nextCursor:'next-page'});
      return pending.promise.then(()=>Response.json({drafts:[],nextCursor:null}));
    }});
    try{
      if(dismiss)await r.w.cloudListDrafts();
      const loading=r.w.cloudListDrafts(dismiss?'next-page':'');await settle();
      if(dismiss)r.w.closeModal();else r.w.go('settings');
      pending.resolve();await loading;
      assert.equal(r.w.document.querySelector('#modal').classList.contains('on'),false);
    }finally{r.close()}
  }
});

test('Closing a pending draft read preserves empty and dirty editors',async()=>{
  for(const dirty of [false,true]){
    const pending=deferred();
    const r=runtime({fetchImpl:async path=>path==='/session'?Response.json(session):path==='/storage/drafts'?Response.json({drafts:[envelope()],nextCursor:null}):pending.promise.then(()=>Response.json(envelope()))});
    try{
      if(dirty)edit(r,'Nội dung chưa lưu');
      await r.w.cloudListDrafts();const opening=r.w.cloudOpenDraft('cloud-a');await settle();
      r.w.closeModal();pending.resolve();await opening;
      assert.equal(r.read('D.content'),dirty?'Nội dung chưa lưu':'');assert.equal(r.read('!!D.cloud'),false);
      assert.equal(r.w.document.querySelector('#modal').classList.contains('on'),false);
    }finally{r.close()}
  }
});

test('Leaving and returning invalidates draft reads and old confirmation callbacks',async()=>{
  for(const confirm of [false,true]){
    const pending=deferred();
    const r=runtime({fetchImpl:async path=>path==='/session'?Response.json(session):pending.promise.then(()=>Response.json(envelope()))});
    try{
      if(confirm)edit(r,'Giữ nguyên bản nháp');
      const opening=r.w.cloudOpenDraft('cloud-a');await settle();
      if(confirm){pending.resolve();await opening;assert.ok(r.w.document.querySelector('#ask_yes'))}
      r.w.go('settings');r.w.go('create');
      if(confirm)r.w.document.querySelector('#ask_yes').click();else{pending.resolve();await opening}
      assert.equal(r.read('D.content'),confirm?'Giữ nguyên bản nháp':'');assert.equal(r.read('!!D.cloud'),false);
    }finally{r.close()}
  }
});

test('Managed channels are read from server and disabled until OAuth is configured',async()=>{
  const r=runtime({fetchImpl:async path=>path==='/session'?Response.json(session):Response.json({configured:false,channels:[]})});
  try{r.read("render('accounts')");await settle();assert.ok(r.w.document.querySelector('#facebook_connect').disabled);assert.match(r.w.document.querySelector('#facebook_status').textContent,/chưa.*cấu hình/i);assert.ok(!r.w.document.querySelector('#view').textContent.includes('Đã kết nối tất cả'))}finally{r.close()}
});
test('Channel inventory escapes provider text and never enables demo publishing',async()=>{
 const r=runtime({fetchImpl:async path=>path==='/session'?Response.json(session):Response.json({configured:true,channels:[{pageId:'123',name:'<img src=x onerror=alert(1)>',status:'connected',verifiedAt:1000,scopes:['pages_show_list'],tasks:[]}]})});
 try{r.read("render('accounts')");await settle();assert.equal(r.w.document.querySelectorAll('#facebook_list img').length,0);assert.match(r.w.document.querySelector('#facebook_list').textContent,/<img/);assert.equal(r.read('S.channels.length'),0);assert.match(r.w.document.querySelector('#view').textContent,/chưa bật/i)}finally{r.close()}
});
