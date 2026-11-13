import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
const source=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const scope='a'.repeat(64);
const session={userScope:scope,capabilities:{ai:true,drafts:true,publishing:false,scheduling:false,inbox:false}};
const envelope=(id='cloud-a',content='Đã lưu từ thiết bị khác',revision=1)=>({draft:{id,type:'post',content,channels:[],status:'draft',media:[],assets:[],custom:{}},revision,updatedAt:1000});
// api: mock cho /api/* (shop, thành viên, lời mời); mặc định trả tài khoản chưa có shop để các mock bản nháp cũ không bị lẫn yêu cầu khởi động.
function runtime({managed=true,fetchImpl,stored={},api,invite='',route=''}={}) {
  const requests=[],errors=[];
  const html=managed?source.replace('<head>','<head><meta name="shopai-ai-endpoint" content="/ai"><meta name="shopai-user-scope" content="'+scope+'">'+(invite?'<meta name="shoppost-invite" content="'+invite+'">':'')):source;
  const dom=new JSDOM(html,{url:'https://app.example/'+(route?'#'+route:''),runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:new VirtualConsole(),beforeParse(w){
    w.scrollTo=()=>{};w.AbortSignal=AbortSignal;w.TextEncoder=TextEncoder;
    for(const [k,v] of Object.entries(stored))w.localStorage.setItem(k,JSON.stringify(v));
    w.fetch=async(url,options={})=>{const path=new URL(url,w.location.href).pathname;requests.push({path,...options});if(path.startsWith('/api/'))return api?api(path,options):Response.json({shops:[],defaultShopId:null,admin:false,roles:{}});return fetchImpl?fetchImpl(path,options):Response.json(session)};
    w.addEventListener('error',e=>errors.push(e.error));
  }});
  const w=dom.window;
  return {dom,w,requests,errors,read:s=>w.eval(s),close:()=>w.close()};
}
const settle=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
test('YouTube UI distinguishes setup from connection and sends the chosen video as binary',async()=>{
 const r=runtime();try{
  await settle();r.read("SHOP.permissions=['channels.configure_token','channels.operate']");
  const disabled=r.read("googleSection({configured:false,accounts:[]},{uploads:[]})");
  assert.match(disabled,/disabled/);assert.match(disabled,/chưa|cần hoàn tất/i);
  const section=r.read(`googleSection({configured:true,accounts:[{id:'yt-test',name:'<script>bad</script>',targetId:'UCtest',status:'connected'}]},{uploads:[]})`);
  r.w.document.querySelector('#view').innerHTML=section;assert.equal(r.w.document.querySelector('#view script'),null);
  const file=new r.w.File(['video'],'test.mp4',{type:'video/mp4'});
  Object.defineProperty(r.w.document.querySelector('#yt_file'),'files',{value:[file]});
  r.w.document.querySelector('#yt_title').value='My video';r.w.document.querySelector('#yt_kids').value='false';
  r.w.confirm=()=>true;r.w.crypto.randomUUID=()=> 'test-video-idempotency-key';r.w.socialAccountsLive=()=>{};
  let received;r.w.fetch=async(url,opts)=>{received={url,opts};return Response.json({videoId:'abcdefghijk'});};
  await r.w.googleUpload();assert.equal(received.opts.body,file);assert.equal(received.opts.headers['Content-Type'],'video/mp4');assert.equal(received.opts.headers['Idempotency-Key'],'test-video-idempotency-key');assert.match(received.url,/privacy=private/);
  assert.match(r.w.document.querySelector('#yt_status').textContent,/abcdefghijk/);
  let counter=0;const keys=[];r.w.crypto.randomUUID=()=> 'retry-video-attempt-'+(++counter);
  r.w.fetch=async(url,opts)=>{keys.push(opts.headers['Idempotency-Key']);return keys.length===1?Response.json({error:'youtube_upload_failed',status:'failed'},{status:502}):Response.json({videoId:'abcdefghijk'});};
  await r.w.googleUpload();await r.w.googleUpload();assert.notEqual(keys[0],keys[1],'a confirmed pre-send failure allows a fresh attempt');
 }finally{r.close();}
});
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

test('Unavailable media, custom content or incomplete schedules do not get silently dropped',async()=>{
  for(const change of ['D.media=[{type:"image/png"}]','D.custom={x:{text:"riêng"}}','D.textAssets=["a"]','D.when="later"']){
    const r=runtime();try{await settle();edit(r);r.read(change);await r.w.cloudSaveDraft();assert.equal(r.requests.filter(x=>x.method==='PUT').length,0);assert.equal(r.read('!!D.cloud'),false)}finally{r.close()}
  }
});

test('Cloud draft round trip restores two original files and the intended schedule',async()=>{
  let saved;
  const r=runtime({fetchImpl:async(path,options)=>{
    if(path==='/session')return Response.json(session);
    if(options.method==='PUT'){
      assert.equal(options.headers['Content-Type'],undefined);
      const {draft,revision}=JSON.parse(options.body.get('payload'));
      assert.equal(revision,0);
      const files=options.body.getAll('file');
      assert.deepEqual(await Promise.all(files.map(file=>file.text())),['first original','second original']);
      const media=files.map(file=>({id:crypto.randomUUID(),name:file.name,type:file.type,size:file.size}));
      saved={...envelope(draft.id,draft.content),draft:{...draft,media}};
      return Response.json(saved);
    }
    const file=saved.draft.media.find(file=>path.endsWith('/media/'+file.id));
    if(file)return new Response(file.name==='first.png'?'first original':'second original',{headers:{'Content-Type':file.type}});
    return Response.json(saved);
  }});
  try{
    await settle();edit(r);
    r.w.Blob=Blob;r.w.FormData=FormData;r.w.URL.createObjectURL=URL.createObjectURL;
    r.read(`D.media=[{name:'first.png',type:'image/png',file:new Blob(['first original'],{type:'image/png'})},{name:'second.jpg',type:'image/jpeg',file:new Blob(['second original'],{type:'image/jpeg'})}];D.when='later';D.date='2027-01-01';D.time='11:30';`);
    await r.w.cloudSaveDraft();
    assert.equal(r.read('D.cloud.revision'),1);
    r.read('D=newDraft()');
    await r.w.cloudOpenDraft(saved.draft.id);
    assert.equal(r.read('D.content'),'Bản nháp cần lưu');
    assert.equal(r.read('D.media.length'),2);
    assert.equal(await r.read('D.media[1].file.text()'),'second original');
    assert.equal(r.read('D.date'),'2027-01-01');
    assert.equal(r.read('D.time'),'11:30');
    assert.equal(r.requests.filter(request=>request.method==='POST').length,0);
    r.read('D.media.forEach(file=>URL.revokeObjectURL?.(file.url))');
  }finally{r.close()}
});

test('A missing attachment on the server keeps the current editor intact',async()=>{
  const row=envelope();
  row.draft.media=[{id:crypto.randomUUID(),name:'missing.png',type:'image/png',size:1}];
  const r=runtime({fetchImpl:async path=>path==='/session'?Response.json(session):path.includes('/media/')?Response.json({error:'Tệp không còn.'},{status:404}):Response.json(row)});
  try{
    await settle();edit(r,'Bản đang soạn');
    await r.w.cloudOpenDraft(row.draft.id);
    assert.equal(r.read('D.content'),'Bản đang soạn');
    assert.match(r.w.document.querySelector('#cloud_status').textContent,/Tệp không còn/);
  }finally{r.close()}
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

test('Nhập JSON loại bỏ bản ghi có id độc hại và tham chiếu id không hợp lệ',()=>{
  const r=runtime({managed:false});try{
    const malicious={v:3,posts:[{id:"a') ;alert(1)//",type:'post'},{id:'good_1',type:'post',channels:["x');//",'c_ok'],assets:['id xấu','a_ok']}],channels:[{id:'c_ok'},{id:'<img src=x>'}],groups:[{id:'g1',channels:['c_ok','evil"']}]};
    const out=JSON.parse(r.read('(()=>{const o=sanitizeImport('+JSON.stringify(malicious)+');return JSON.stringify({postIds:o.posts.map(p=>p.id),ch:o.posts[0]?o.posts[0].channels:null,assets:o.posts[0]?o.posts[0].assets:null,chIds:o.channels.map(c=>c.id),gch:o.groups[0].channels})})()'));
    assert.deepEqual(out.postIds,['good_1']);
    assert.deepEqual(out.ch,['c_ok']);
    assert.deepEqual(out.assets,['a_ok']);
    assert.deepEqual(out.chIds,['c_ok']);
    assert.deepEqual(out.gch,['c_ok']);
  }finally{r.close()}
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

// ===== Shop, thành viên & phân quyền trên giao diện =====
const shopOf=(id,name,role,permissions,extra={})=>({id,name,role,roleLabel:{owner:'Chủ shop',manager:'Quản lý shop',content:'Nhân viên nội dung',support:'Nhân viên CSKH',viewer:'Chỉ xem'}[role],canPublish:role==='owner',permissions,status:'active',memberCount:1,...extra});
const OWNER_PERMS=['shop.view','shop.update','shop.delete','shop.transfer','members.view','members.invite','members.update_role','members.remove','drafts.view','drafts.create','drafts.edit_own','drafts.edit_any','drafts.submit','drafts.approve','drafts.publish','drafts.delete','ai.use'];
const shopsBody=(current='s_aaaaaaaaaa')=>({shops:[shopOf('s_aaaaaaaaaa','Shop của tôi','owner',OWNER_PERMS),shopOf('s_bbbbbbbbbb','Shop phụ','viewer',['shop.view','members.view','drafts.view','reports.view'])],defaultShopId:current,admin:false,roles:{owner:'Chủ shop',manager:'Quản lý shop',content:'Nhân viên nội dung',support:'Nhân viên CSKH',viewer:'Chỉ xem'}});
const settleMore=async(n=4)=>{for(let i=0;i<n;i++)await settle()};

test('Bộ chọn shop hiển thị shop hiện hành và vai trò; đổi shop gửi header X-ShopPost-Shop và khóa lưu với vai trò Chỉ xem',async()=>{
  const r=runtime({api:async path=>path==='/api/shops'?Response.json(shopsBody()):path==='/api/shops/s_bbbbbbbbbb/members'?Response.json({members:[{userId:'email:a@b.vn',name:'',provider:'email',role:'owner',roleLabel:'Chủ shop',canPublish:true,createdAt:1,you:false}]}):Response.json({error:'Không tìm thấy endpoint.'},{status:404})});
  try{
    await settleMore();assert.deepEqual(r.errors,[]);
    const box=r.w.document.querySelector('#shop_box');assert.equal(box.hidden,false);
    assert.equal(r.w.document.querySelector('#shop_sel').value,'s_aaaaaaaaaa');assert.match(box.textContent,/Chủ shop/);
    assert.equal(r.w.document.querySelector('#mshop').options.length,2);
    assert.ok([...r.w.document.querySelectorAll('#nav a')].some(a=>a.textContent.includes('Thành viên & phân quyền')));
    assert.ok(![...r.w.document.querySelectorAll('#nav a')].some(a=>a.textContent.includes('Quản trị nền tảng')));
    assert.equal(r.w.document.querySelector('#cloud_save').disabled,false);
    edit(r,'Nháp trong shop chính');await r.w.cloudSaveDraft();
    const put=r.requests.find(x=>x.method==='PUT');assert.ok(put);assert.equal(put.headers['X-ShopPost-Shop'],'s_aaaaaaaaaa');
    r.w.shopSwitch('s_bbbbbbbbbb');await settleMore();
    assert.equal(r.w.localStorage.getItem('pdk_shop:'+scope),'s_bbbbbbbbbb');
    assert.match(r.w.document.querySelector('#shop_box').textContent,/Chỉ xem/);
    assert.equal(r.w.document.querySelector('#cloud_save').disabled,true);assert.match(r.w.document.querySelector('#view').textContent,/chỉ được xem/);
    r.w.go('members');await settleMore();
    const view=r.w.document.querySelector('#view').textContent;
    assert.match(view,/Thành viên của shop “Shop phụ”/);assert.match(view,/email:a@b.vn/);assert.match(view,/Quản trị nền tảng/);
    assert.equal(r.w.document.querySelector('#inv_btn'),null);assert.equal(r.w.document.querySelector('#tr_to'),null);
    assert.equal(r.w.document.querySelector('#shop_sel').value,'s_bbbbbbbbbb');
  }finally{r.close()}
});

test('Trang thành viên của chủ shop: mời, link mời, thu hồi, đổi vai trò; lỗi reauth_required hướng dẫn đăng nhập lại',async()=>{
  const calls=[];
  const r=runtime({api:async(path,options)=>{calls.push({path,method:options.method||'GET',body:options.body?JSON.parse(options.body):null});
    if(path==='/api/shops')return Response.json(shopsBody());
    if(path==='/api/shops/s_aaaaaaaaaa/members')return Response.json({members:[{userId:'email:me@b.vn',name:'Tôi',provider:'email',role:'owner',roleLabel:'Chủ shop',canPublish:true,createdAt:1,you:true},{userId:'fb:2',name:'Bạn B',provider:'fb',role:'content',roleLabel:'Nhân viên nội dung',canPublish:false,createdAt:2,you:false}]});
    if(path==='/api/shops/s_aaaaaaaaaa/invites'&&options.method==='POST')return Response.json({invite:{id:'inv_12345678',email:'x@y.vn',role:'viewer',roleLabel:'Chỉ xem',expiresAt:9},link:'https://app.example/invite/'+'t'.repeat(43),emailed:false},{status:201});
    if(path==='/api/shops/s_aaaaaaaaaa/invites')return Response.json({invites:[{id:'inv_12345678',email:'x@y.vn',role:'viewer',roleLabel:'Chỉ xem',expiresAt:9,createdBy:'email:me@b.vn',createdAt:1}]});
    if(path==='/api/shops/s_aaaaaaaaaa/invites/inv_12345678'&&options.method==='DELETE')return Response.json({ok:true});
    if(path==='/api/shops/s_aaaaaaaaaa/members/fb%3A2'&&options.method==='PATCH')return Response.json({ok:true});
    if(path==='/api/shops/s_aaaaaaaaaa/transfer')return Response.json({error:'Thao tác nhạy cảm cần đăng nhập lại trong 10 phút gần nhất.',code:'reauth_required'},{status:403});
    return Response.json({error:'Không tìm thấy endpoint.'},{status:404});
  }});
  try{
    r.w.QA_RUNNING=false;await settleMore();r.w.go('members');await settleMore();
    const doc=r.w.document,view=()=>doc.querySelector('#view').textContent;
    assert.match(view(),/Bạn B/);assert.match(view(),/x@y.vn/);assert.ok(doc.querySelector('#inv_btn'));assert.ok(doc.querySelector('#tr_to'));
    assert.equal(doc.querySelector('#tr_to').options.length,1);assert.equal(doc.querySelector('#tr_to').value,'fb:2');
    doc.querySelector('#inv_email').value='x@y.vn';doc.querySelector('#inv_role').value='viewer';await r.w.inviteCreate();await settleMore();
    const created=calls.find(c=>c.method==='POST'&&c.path.endsWith('/invites'));assert.deepEqual(created.body,{email:'x@y.vn',role:'viewer'});
    assert.equal(doc.querySelector('#inv_link').value,'https://app.example/invite/'+'t'.repeat(43));
    await r.w.memberRole('fb:2','manager');assert.deepEqual(calls.find(c=>c.method==='PATCH').body,{role:'manager'});
    r.w.ask=(msg,yes)=>yes();r.w.inviteRevoke('inv_12345678');await settleMore();assert.ok(calls.some(c=>c.method==='DELETE'&&c.path.endsWith('/invites/inv_12345678')));
    r.w.shopTransfer();await settleMore();
    assert.ok(calls.some(c=>c.path.endsWith('/transfer')&&c.body.to==='fb:2'));
    assert.ok(doc.querySelector('#modal').classList.contains('on'));assert.match(doc.querySelector('#mbox').textContent,/đăng xuất rồi đăng nhập lại/);
    assert.deepEqual(r.errors,[]);
  }finally{r.close()}
});

test('Lời mời trong meta được hỏi và chấp nhận; shop mới trở thành shop hiện hành',async()=>{
  const token='k'.repeat(43);const calls=[];
  const r=runtime({invite:token,api:async(path,options)=>{calls.push({path,method:options.method||'GET'});
    if(path==='/api/shops')return Response.json(shopsBody());
    if(path==='/api/invites/'+token)return Response.json({invite:{shop:{id:'s_cccccccccc',name:'Shop được mời'},role:'viewer',roleLabel:'Chỉ xem',email:null,expiresAt:9,state:'pending'}});
    if(path==='/api/invites/'+token+'/accept')return Response.json({joined:true,alreadyMember:false,shop:shopOf('s_cccccccccc','Shop được mời','viewer',['shop.view','drafts.view'])});
    return Response.json({error:'Không tìm thấy endpoint.'},{status:404});
  }});
  try{
    await settleMore();const doc=r.w.document;
    assert.ok(doc.querySelector('#modal').classList.contains('on'));assert.match(doc.querySelector('#mbox').textContent,/Shop được mời/);assert.match(doc.querySelector('#mbox').textContent,/Chỉ xem/);
    [...doc.querySelectorAll('#mbox button')].find(b=>b.textContent==='Tham gia').click();await settleMore();
    assert.ok(calls.some(c=>c.path.endsWith('/accept')&&c.method==='POST'));
    assert.equal(doc.querySelector('#shop_sel').value,'s_cccccccccc');assert.equal(doc.querySelector('#shop_sel').options.length,3);
    assert.deepEqual(r.errors,[]);
  }finally{r.close()}
});

test('Danh sách bản nháp máy chủ hiển thị trạng thái và nút Gửi duyệt/Duyệt theo vai trò; đổi trạng thái gọi đúng endpoint',async()=>{
  const statuses=[];
  const content=shopOf('s_aaaaaaaaaa','Shop của tôi','content',['shop.view','members.view','drafts.view','drafts.create','drafts.edit_own','drafts.submit','ai.use']);
  const r=runtime({api:async()=>Response.json({shops:[content],defaultShopId:content.id,admin:false,roles:{}}),fetchImpl:async(path,options)=>{
    if(path==='/session')return Response.json(session);
    if(path.endsWith('/status')){statuses.push({path,body:JSON.parse(options.body)});return Response.json({...envelope(),status:'pending_review',revision:2})}
    return Response.json({drafts:[{...envelope('cloud-a','Bài chờ gửi'),status:'draft'},{...envelope('cloud-b','Bài đã gửi'),status:'pending_review'}],nextCursor:null});
  }});
  try{
    await settleMore();await r.w.cloudListDrafts();
    const text=r.w.document.querySelector('#mbox').textContent;
    assert.match(text,/Bản nháp/);assert.match(text,/Chờ duyệt/);
    const buttons=[...r.w.document.querySelectorAll('#mbox button')].map(b=>b.textContent);
    assert.ok(buttons.includes('Gửi duyệt'));assert.ok(!buttons.includes('Duyệt'));assert.ok(!buttons.includes('Xóa'));
    await r.w.cloudSetStatus('cloud-a','pending_review');await settleMore();
    assert.deepEqual(statuses,[{path:'/storage/drafts/cloud-a/status',body:{status:'pending_review'}}]);
    assert.deepEqual(r.errors,[]);
  }finally{r.close()}
});

test('live job update preserves typed channel content and updates only history and matching schedule',async()=>{
 const r=runtime();try{await settle();r.read(`SHOP.ready=true;SHOP.id='shop-a';S.posts=[{id:'local',schedId:'job-a',status:'scheduled',channels:[],metrics:{}}];document.querySelector('#view').innerHTML='<textarea id="tg_text">Nội dung đang soạn</textarea><div id="live_job_history"></div>';`);
 assert.equal(typeof r.w.applyPublishJobs,'function');
 r.w.applyPublishJobs([{id:'job-a',kind:'photo',status:'sent',attempts:1,remoteMessageId:'remote-a',url:'https://example.com/post'}],'shop-a');
 assert.equal(r.w.document.querySelector('#tg_text').value,'Nội dung đang soạn');assert.equal(r.read('S.posts[0].status'),'published');
 r.w.applyPublishJobs([{id:'job-a',kind:'photo',status:'failed',attempts:1}],'shop-b');
 assert.equal(r.read('S.posts[0].status'),'published');
 }finally{r.close();}
});

test('Zalo publishing preserves the idempotency header and caller cancellation signal',async()=>{
 const r=runtime({fetchImpl:async(path)=>path==='/channels/zalo/publish'?Response.json({ok:true,job:{id:'pj_one',status:'sent'}}):Response.json(session)});
 try{await settle();r.read("SHOP.ready=true;SHOP.id='shop';D.publishKey='stable-zalo-key-123'");
 await r.w.zaloPublishDraft('Content','',['https://example.com/cover.jpg']);
 const req=r.requests.find(x=>x.path==='/channels/zalo/publish');assert.equal(req.headers['Idempotency-Key'],'stable-zalo-key-123');
 const controller=new AbortController();await r.w.cloudRequest('/session',{signal:controller.signal});controller.abort();
 assert.equal(r.requests.filter(x=>x.path==='/session').at(-1).signal.aborted,true);
 }finally{r.close();}
});
test('immediate Zalo rate-limit responses retain the common job for later successful reconciliation',async()=>{
 const r=runtime({fetchImpl:async(path)=>path==='/channels/all/jobs'?Response.json({job:{id:'pj_retry',status:'retryable',kind:'photo',attempts:1},retryAfter:30},{status:429}):Response.json(session)});
 try{await settle();r.read("SHOP.ready=true;SHOP.id='shop';SHOP.permissions=['channels.operate'];S.channels=[{id:'real_zalo',accountId:'zalo-a',name:'OA',pf:'zalo',real:true,provider:'zalo',connected:true}];D.content='Queued content';D.channels=['real_zalo'];D.media=[{type:'image/jpeg',thumb:'data:image/jpeg;base64,/9j/AA==',name:'cover',size:4}]");
 r.w.confirm=()=>true;await r.w.submitPostReal(['real_zalo']);assert.equal(r.read('S.posts[0].schedId'),'pj_retry');assert.equal(r.read('S.posts[0].status'),'scheduled');
 r.w.applyPublishJobs([{id:'pj_retry',status:'sent',kind:'photo',attempts:2}],'shop');assert.equal(r.read('S.posts[0].status'),'published');
 }finally{r.close();}
});

test('composer loads connected Facebook channels without overwriting the draft and enables publishing',async()=>{
 const r=runtime({fetchImpl:async(path)=>path==='/channels'?Response.json({channels:[]}):path==='/channels/all/accounts'?Response.json({accounts:[{id:'fb-a',provider:'facebook',name:'ShopTrack',targetId:'123',status:'active'},{id:'fb-old',provider:'facebook',name:'Revoked',status:'revoked'}]}):Response.json(session)});
 try{await settle();r.read("SHOP.ready=true;SHOP.id='shop';D.content='Keep my draft';D.media=[{type:'image/png',thumb:'data:image/png;base64,iVBORw0KGgo='}]");await r.w.channelsLoad();
 assert.equal(r.read('D.content'),'Keep my draft');assert.equal(r.read('D.media.length'),1);
 assert.equal(r.read('S.channels.filter(c=>c.connected&&c.pf===\"facebook\").length'),1);
 r.w.selAll(1);assert.equal(r.w.document.querySelector('#sub').disabled,false);assert.match(r.w.document.querySelector('#chlist').textContent,/ShopTrack/);
 }finally{r.close();}
});
test('Facebook composer confirms exact channel and sends all photos with stable idempotency while blocking double clicks',async()=>{
 const pending=deferred(),sent=[];let confirmations=0;
 const r=runtime({fetchImpl:async(path,opts)=>{if(path==='/channels/all/jobs'&&opts.method==='POST'){sent.push(opts);await pending.promise;return Response.json({ok:true,job:{id:'pj_fb',status:'sent',url:'https://www.facebook.com/123_9'},url:'https://www.facebook.com/123_9'});}return Response.json(session);}});
 try{await settle();r.w.crypto.randomUUID=()=> 'stable-facebook-composer-key';r.w.confirm=msg=>{confirmations++;assert.match(msg,/ShopTrack/);return true;};
 r.read("SHOP.ready=true;SHOP.id='shop';SHOP.permissions=['channels.operate'];S.channels=[{id:'real_fb',accountId:'fb-a',pf:'facebook',provider:'facebook',real:true,name:'ShopTrack',connected:true}];D.content='Caption';D.channels=['real_fb'];D.media=[{type:'image/png',thumb:'data:image/png;base64,iVBORw0KGgo='},{type:'image/jpeg',thumb:'data:image/jpeg;base64,/9j/AA=='}]");
 const first=r.w.submitPostReal(['real_fb']);await settle();await r.w.submitPostReal(['real_fb']);assert.equal(sent.length,1);assert.equal(confirmations,1);
 const payload=JSON.parse(sent[0].body);assert.equal(payload.accountId,'fb-a');assert.equal(payload.images.length,2);assert.equal(payload.text,'Caption');assert.equal(sent[0].headers['Idempotency-Key'],'stable-facebook-composer-key');
 pending.resolve();await first;assert.equal(r.read('S.posts[0].status'),'published');assert.equal(r.read('S.posts[0].url'),'https://www.facebook.com/123_9');assert.equal(r.read('D.content'),'');
 }finally{r.close();}
});

test('channel loading from a previous shop never clears the new shop connections',async()=>{
 const pending=deferred(),r=runtime({fetchImpl:async(path)=>path==='/channels'?pending.promise:Response.json({accounts:[]})});
 try{await settle();r.read("SHOP.ready=true;SHOP.id='shop-a'");const load=r.w.channelsLoad();r.read("SHOP.id='shop-b';REALCH=[{id:'fb-b',name:'New shop',provider:'facebook',status:'connected'}];syncRealChannels()");pending.resolve(Response.json({channels:[]}));await load;assert.equal(r.read('S.channels[0].name'),'New shop');}finally{r.close();}
});
test('a declined confirmation and unsupported video never send a composer job',async()=>{
 const r=runtime();try{await settle();r.read("SHOP.ready=true;SHOP.id='shop';S.channels=[{id:'fb',accountId:'a',pf:'facebook',provider:'facebook',name:'Page',connected:true,real:true}];D.content='Keep';D.channels=['fb']");r.w.confirm=()=>false;await r.w.submitPostReal(['fb']);r.read("D.media=[{type:'video/mp4',thumb:'poster'}]");r.w.confirm=()=>true;await r.w.submitPostReal(['fb']);assert.equal(r.requests.filter(x=>x.path==='/channels/all/jobs'&&x.method==='POST').length,0);assert.equal(r.read('D.content'),'Keep');}finally{r.close();}
});
test('partial channel delivery never marks a multi-channel post fully published',async()=>{
 const r=runtime();try{await settle();r.read("SHOP.id='shop';S.posts=[{id:'post',jobs:[{id:'one',status:'pending'},{id:'two',status:'pending'}],status:'scheduled'}]");r.w.applyPublishJobs([{id:'one',status:'sent',url:'https://example.com/post'}],'shop');assert.equal(r.read('S.posts[0].status'),'scheduled');r.w.applyPublishJobs([{id:'two',status:'unknown'}],'shop');assert.equal(r.read('S.posts[0].status'),'unknown');r.w.applyPublishJobs([{id:'two',status:'sent'}],'shop');assert.equal(r.read('S.posts[0].status'),'published');}finally{r.close();}
});

test('mixed Facebook and Zalo composer channels retain both backend account IDs',async()=>{
 const r=runtime({fetchImpl:async(path)=>path==='/channels'?Response.json({channels:[{provider:'zalo',external_id:'456',status:'connected',name:'OA'}]}):path==='/channels/all/accounts'?Response.json({accounts:[{id:'zalo-a',provider:'zalo',targetId:'456',status:'active'},{id:'fb-a',provider:'facebook',name:'Page',targetId:'123',status:'active'}]}):Response.json(session)});
 try{await settle();r.read("SHOP.ready=true;SHOP.id='shop'");await r.w.channelsLoad();assert.equal(r.read('S.channels.find(c=>c.pf===\"zalo\").accountId'),'zalo-a');assert.equal(r.read('S.channels.find(c=>c.pf===\"facebook\").accountId'),'fb-a');}finally{r.close();}
});
test('published history uses the submitted snapshot while keeping edits made during delivery',async()=>{
 const pending=deferred(),r=runtime({fetchImpl:async(path,opts)=>path==='/channels/all/jobs'&&opts.method==='POST'?pending.promise:Response.json(session)});
 try{await settle();r.w.confirm=()=>true;r.w.crypto.randomUUID=()=> 'immutable-submission-test-key';r.read("SHOP.ready=true;SHOP.id='shop';S.channels=[{id:'fb',accountId:'a',pf:'facebook',provider:'facebook',name:'Page',connected:true,real:true}];D.content='Submitted';D.channels=['fb']");const send=r.w.submitPostReal(['fb']);await settle();r.read("D.content='New unsent edit';D.media=[{type:'image/png',thumb:'new-photo'}]");pending.resolve(Response.json({ok:true,job:{id:'sent-snapshot',status:'sent'}}));await send;assert.equal(r.read('S.posts[0].content'),'Submitted');assert.equal(r.read('S.posts[0].media.length'),0);assert.equal(r.read('D.content'),'New unsent edit');assert.equal(r.read('D.media.length'),1);}finally{r.close();}
});

test('real connection inventory counts Facebook and YouTube and never counts configuration or revoked accounts',async()=>{
 const r=runtime();try{await settle();r.read("SHOP.ready=true;SHOP.id='shop'");
 r.w.updateConnectionInventory({accounts:[{id:'fb',name:'ShopTrack',provider:'facebook',targetId:'123',status:'active'},{id:'old',name:'Old',provider:'facebook',targetId:'456',status:'revoked'},{id:'bad',name:'Missing identity',provider:'telegram',status:'active'}]},{channels:[],setup:{zalo:{configured:true}}},{configured:true,accounts:[{id:'yt',name:'My YouTube',targetId:'UCtest',status:'connected'}]},'shop');
 const card=r.w.connectionSummary();assert.match(card,/2 tài khoản đã kết nối thật/);assert.match(card,/Facebook/);assert.match(card,/YouTube/);r.read("CHANNEL_TAB='available'");const available=r.w.connectionSummary();assert.match(available,/Chưa kết nối/);assert.match(available,/Đã ngắt kết nối/);assert.match(card,/Cần cấp quyền lại/);assert.match(r.w.document.querySelector('#shop_box').textContent,/2 kênh đã kết nối thật/);
 }finally{r.close();}
});
test('connection status comes only from matching shop server data and incomplete reads never retain stale success',async()=>{
 const r=runtime();try{await settle();r.read("SHOP.ready=true;SHOP.id='a'");r.w.updateConnectionInventory({accounts:[{id:'fb',name:'<script>bad</script>',provider:'facebook',targetId:'123',status:'active'}]},{channels:[]},{accounts:[]},'a');assert.doesNotMatch(r.w.connectionSummary(),/<script>/);
 r.read("SHOP.id='b'");assert.doesNotMatch(r.w.connectionSummary(),/bad/);r.w.updateConnectionInventory({accounts:[]},{channels:[]},{accounts:[]},'a');assert.doesNotMatch(r.w.connectionSummary(),/bad/);
 r.w.updateConnectionInventory(null,{channels:[]},{accounts:[]},'b');assert.match(r.w.connectionSummary(),/Chưa xác nhận đủ/);assert.doesNotMatch(r.w.connectionSummary(),/1 tài khoản đã kết nối thật/);
 }finally{r.close();}
});

test('partial Zalo metadata stays visible as connected but is not publish selectable without its account ID',async()=>{
 const r=runtime();try{await settle();r.read("SHOP.ready=true;SHOP.id='shop'");r.w.updateConnectionInventory(null,{channels:[{provider:'zalo',name:'OA',external_id:'123',status:'connected'}]},{accounts:[]},'shop');assert.match(r.w.connectionSummary(),/Đã kết nối thật/);assert.equal(r.read('S.channels.filter(c=>c.real).length'),0);assert.match(r.w.document.querySelector('#shop_box').textContent,/cần kiểm tra lại/);
 r.w.updateConnectionInventory({accounts:[{id:'zalo-a',provider:'zalo',targetId:'123',status:'active'}]},{channels:[{provider:'zalo',name:'OA',external_id:'123',status:'connected'}]},{accounts:[]},'shop');assert.equal(r.read('S.channels[0].accountId'),'zalo-a');
 }finally{r.close();}
});

test('account controls expose login logout and add-account without logging out on render',async()=>{
 const r=runtime();try{await settle();for(const id of ['login_btn','logout_btn','switch_account_btn'])assert.ok(r.w.document.getElementById(id));assert.equal(r.w.document.getElementById('login_btn').hidden,true);assert.equal(r.w.document.querySelector('header #add_account_btn'),null);assert.equal(r.requests.filter(x=>x.path==='/auth/logout').length,0);
 r.read("SHOP.ready=true;SHOP.id='shop';SHOP.permissions=['channels.configure_token']");r.w.socialRequest=async()=>({facebook:{enabled:true}});r.w.cloudRequest=async()=>({setup:{zalo:{configured:true}}});r.w.googleRequest=async()=>({configured:true});await r.w.openAddAccount();assert.match(r.w.document.querySelector('#mbox').textContent,/Facebook/);assert.match(r.w.document.querySelector('#mbox').textContent,/YouTube/);assert.match(r.w.document.querySelector('#mbox').textContent,/Telegram/);assert.equal(r.requests.filter(x=>x.method==='POST').length,0);
 }finally{r.close();}
});
test('logout failures retain the session and re-enable the controls, cancellation sends nothing',async()=>{
 const r=runtime({fetchImpl:async(path)=>path==='/auth/logout'?Response.json({error:'Try later'},{status:503}):Response.json(session)});try{await settle();r.w.confirm=()=>false;await r.w.logoutShopPost();assert.equal(r.requests.filter(x=>x.path==='/auth/logout').length,0);r.w.confirm=()=>true;await r.w.logoutShopPost();assert.equal(r.requests.filter(x=>x.path==='/auth/logout').length,1);assert.equal(r.w.document.getElementById('logout_btn').disabled,false);assert.equal(r.w.location.pathname,'/');assert.match(r.w.document.querySelector('#toast').textContent,/Try later/);}finally{r.close();}
});

test('add-account respects viewer permissions and refuses a stale shop action',async()=>{
 const r=runtime();try{await settle();r.read("SHOP.ready=true;SHOP.id='shop';SHOP.permissions=[]");r.w.socialRequest=async()=>({facebook:{enabled:true},instagram:{enabled:true},telegram:{enabled:true}});r.w.cloudRequest=async()=>({setup:{zalo:{configured:true}}});r.w.googleRequest=async()=>({configured:true});await r.w.openAddAccount();const buttons=[...r.w.document.querySelectorAll('#mbox button[onclick^="connectAdditionalAccount"]')];assert.equal(buttons.length,5);assert.ok(buttons.every(b=>b.disabled));r.read("SHOP.permissions=['channels.configure_token'];SHOP.id='other'");let calls=0;r.w.socialConnectMeta=()=>calls++;await r.w.connectAdditionalAccount('facebook','shop');assert.equal(calls,0);}finally{r.close();}
});

test('login recovery preserves draft and uses the normal authentication gate for an expired session',async()=>{
 const r=runtime();try{await settle();edit(r,'Preserve before login');r.w.cloudRequest=async()=>{throw Object.assign(Error('Session expired'),{status:401});};await r.w.openShopPostLogin();assert.equal(r.read('D.content'),'Preserve before login');assert.match(r.w.localStorage.getItem('pdk_draft_v1:'+scope),/Preserve before login/);assert.equal(r.requests.filter(x=>x.path==='/auth/logout').length,0);}finally{r.close();}
});

test('channel tabs separate shop accounts from available platforms and management menus use exact actions',async()=>{
 const r=runtime();try{await settle();r.read("SHOP.ready=true;SHOP.id='shop';SHOP.permissions=['channels.configure_token'];SHOP.name='My shop'");r.w.updateConnectionInventory({accounts:[{id:'fb',name:'ShopTrack',provider:'facebook',targetId:'123',status:'active'}]},{channels:[]},{accounts:[{id:'yt',name:'Channel',targetId:'UCtest',status:'connected'}]},'shop');
 const html=r.w.connectionSummary();assert.match(html,/Kênh đăng bài/);assert.match(html,/Kết nối kênh/);assert.match(html,/Cấp lại quyền/);assert.match(html,/Ngắt kết nối/);assert.doesNotMatch(html,/Đăng nhập \/ Kết nối/);
 r.read("CHANNEL_TAB='available'");const available=r.w.connectionSummary();assert.match(available,/Instagram/);assert.match(available,/Kết nối thêm/);assert.match(available,/Kết nối Zalo OA/);
 }finally{r.close();}
});
test('Zalo offers replacement for an existing OA and connection for a shop without one',async()=>{
 const r=runtime();
 try{
  await settle();
  r.read("SHOP.ready=true;SHOP.id='shop';SHOP.permissions=['channels.configure_token'];CHANNEL_TAB='available'");
  r.w.socialRequest=async()=>({});
  r.w.googleRequest=async()=>({accounts:[]});
  for(const status of ['connected','expired','revoked']){
   const zalo={channels:[{provider:'zalo',external_id:'123',status}],setup:{zalo:{configured:true}}};
   r.w.cloudRequest=async()=>zalo;
   r.w.updateConnectionInventory({accounts:[]},zalo,{accounts:[]},'shop');
   await r.w.openAddAccount();
   const modal=r.w.document.querySelector('#mbox');
   const button=modal.querySelector('button[onclick^="connectAdditionalAccount(\'zalo\'"]');
   const summary=r.w.connectionSummary();
   if(status==='revoked'){
    assert.equal(button.textContent,'Kết nối');
    assert.match(summary,/aria-label="Kết nối Zalo OA"/);
    assert.doesNotMatch(modal.textContent,/sẽ thay thế/);
   }else{
    assert.equal(button.textContent,'Đổi Zalo OA');
    assert.match(summary,/aria-label="Đổi Zalo OA"/);
    assert.match(summary,/Chọn OA khác sẽ thay thế Zalo OA hiện tại của shop/);
    assert.match(modal.textContent,/Chọn OA khác sẽ thay thế Zalo OA hiện tại của shop/);
   }
  }
 }finally{r.close();}
});
test('account disclosure distinguishes expired login and closes on Escape without logging out',async()=>{
 const r=runtime();try{await settle();r.w.cloudRequest=async()=>{throw Object.assign(Error('expired'),{status:401});};await r.w.refreshAccountMenu();assert.equal(r.w.document.getElementById('login_btn').hidden,false);assert.equal(r.w.document.getElementById('logout_btn').hidden,true);assert.equal(r.w.document.getElementById('switch_account_btn').hidden,true);const menu=r.w.document.getElementById('account_actions');menu.open=true;menu.dispatchEvent(new r.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(menu.open,false);assert.equal(r.requests.filter(x=>x.path==='/auth/logout').length,0);}finally{r.close();}
});

test('channel tab activation keeps keyboard focus and a single tab stop',async()=>{
 const r=runtime();try{await settle();r.read("SHOP.ready=true;SHOP.id='shop';SHOP.permissions=['channels.configure_token']");r.w.updateConnectionInventory({accounts:[]},{channels:[]},{accounts:[]},'shop');r.w.document.querySelector('#view').innerHTML=r.w.connectionSummary();r.w.document.getElementById('tab_available').click();assert.equal(r.w.document.activeElement.id,'tab_available');assert.equal(r.w.document.getElementById('tab_available').tabIndex,0);assert.equal(r.w.document.getElementById('tab_connected').tabIndex,-1);r.w.document.getElementById('tab_available').dispatchEvent(new r.w.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));assert.equal(r.w.document.activeElement.id,'tab_connected');assert.equal(r.w.document.getElementById('tab_connected').tabIndex,0);}finally{r.close();}
});

test('shared design adds clear screen headings and labels without replacing the editor or draft',async()=>{
 const r=runtime();try{await settle();const input=r.w.document.querySelector('#ct');edit(r,'Still my draft');r.w.decorateProductScreen();await settle();assert.equal(r.w.document.querySelector('#ct'),input);assert.equal(input.value,'Still my draft');assert.match(r.w.document.querySelector('#screen_heading').textContent,/Soạn bài/);assert.equal(input.getAttribute('aria-label'),'Nội dung bài viết');assert.equal(r.w.document.querySelector('.drop').getAttribute('role'),'button');assert.equal(r.w.document.querySelector('#toast').getAttribute('aria-live'),'polite');assert.equal(r.w.document.querySelectorAll('.screen-heading').length,1);}finally{r.close();}
});
test('dialogs are labelled, trap focus, and return focus when dismissed',async()=>{
 const r=runtime();try{await settle();const trigger=r.w.document.querySelector('#cloud_open');trigger.focus();r.w.modal('<h3>Test dialog</h3><label>Content</label><input id="dialog_input"><button id="dialog_close" onclick="closeModal()">Close</button>');const box=r.w.document.querySelector('#mbox');assert.equal(box.getAttribute('role'),'dialog');assert.equal(box.getAttribute('aria-modal'),'true');assert.equal(r.w.document.activeElement.id,'dialog_input');assert.equal(r.w.document.querySelector('label[for="dialog_input"]').textContent,'Content');r.w.document.querySelector('#dialog_close').focus();r.w.document.dispatchEvent(new r.w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));assert.equal(r.w.document.activeElement.id,'dialog_input');r.w.closeModal();assert.equal(r.w.document.activeElement,trigger);}finally{r.close();}
});
test('managed library does not offer simulated cloud connectors as real services',async()=>{
 const r=runtime();try{await settle();r.w.go('library');await settle();assert.equal(r.w.document.querySelector('#view .screen-scope'),null);assert.ok(r.w.document.querySelector('#lb_drive'));assert.ok(r.w.document.querySelector('#library_storage details'));assert.equal(r.w.document.querySelectorAll('button[onclick^="lbConnect"]').length,0);}finally{r.close();}
});
test('the post composer generates the selected number of AI articles and applies only the chosen result',async()=>{
 const r=runtime();
 try{
  await settle();
  r.w.go('create');
  r.w.openGen();
  const count=r.w.document.querySelector('#m_count');
  assert.equal(count?.value,'3');
  r.w.document.querySelector('#m_topic').value='ShopTrack';
  r.w.generateTestArticle=async()=> 'Generated article '+(++calls);
  let calls=0;
  r.read('AI.call=window.generateTestArticle');
  for(const requested of [1,5]){
   calls=0;
   count.value=String(requested);
   await r.w.runGen('m');
   const variants=r.w.document.querySelectorAll('#m_out .variant');
   assert.equal(calls,requested);
   assert.equal(variants.length,requested);
   assert.equal(r.read('D.content'),'');
   if(requested===5)variants[4].querySelector('button').click();
  }
  assert.equal(r.read('D.content'),'Generated article 5');
 }finally{r.close();}
});
test('managed settings preview the real AI response and explain rate limiting',async()=>{
 const pending=deferred();
 let limited=false;
 const r=runtime({route:'settings',fetchImpl:async path=>path==='/ai'
  ?limited?Response.json({}, {status:429}):pending.promise
  :Response.json(session)});
 try{
  await settle();
  const doc=r.w.document;
  const button=doc.querySelector('#st_ai_test'),status=doc.querySelector('#st_ai_status'),preview=doc.querySelector('#st_ai_preview');
  assert.equal(doc.querySelector('#st_ai'),null);
  assert.doesNotMatch(doc.querySelector('#view').textContent,/Đặt lại dữ liệu demo/);
  const request=r.w.testAI();
  await r.w.testAI();
  assert.equal(r.requests.filter(req=>req.path==='/ai').length,1);
  assert.equal(button.disabled,true);
  pending.resolve(Response.json({text:'<b>Phản hồi thử</b>'}));
  await request;
  assert.match(status.textContent,/Kết nối AI thành công/);
  assert.equal(preview.textContent,'<b>Phản hồi thử</b>');
  assert.equal(preview.querySelector('b'),null);
  assert.equal(preview.hidden,false);
  assert.equal(button.disabled,false);
  limited=true;
  await r.w.testAI();
  assert.match(status.textContent,/giới hạn/);
  assert.equal(preview.hidden,true);
  assert.equal(button.disabled,false);
 }finally{r.close();}
});
test('AI generation blocks duplicate clicks, preserves updated forms and restores loading controls',async()=>{
 const pending=deferred(),r=runtime();try{await settle();r.w.go('ai');await settle();let calls=0;r.read('AI.call=async()=>"Generated"');r.w.eval('AI.call=async()=>window.pendingGeneration()');r.w.pendingGeneration=()=>{calls++;return pending.promise;};r.w.document.querySelector('#a_topic').value='Original';const button=r.w.document.querySelector('button[onclick="runGen(\'a\')"]'),out=r.w.document.querySelector('#a_out');const request=r.w.runGen('a');await r.w.runGen('a');assert.equal(calls,1);assert.equal(button.disabled,true);r.w.document.querySelector('#a_topic').value='Edited';pending.resolve('Old generated response');await request;assert.equal(button.disabled,false);assert.doesNotMatch(out.textContent,/Old generated response/);assert.match(out.textContent,/Yêu cầu đã dừng/);}finally{r.close();}
});

test('choosing an AI variant uses its own output and preserves edits made before confirmation',async()=>{
 const r=runtime();try{await settle();r.w.go('ai');await settle();r.w.document.querySelector('#a_out')._variants=['Chosen from this form'];r.w._gen=['Unrelated'];r.w.useGen(0,'a');assert.equal(r.read('D.content'),'Chosen from this form');r.w.go('ai');await settle();r.w.document.querySelector('#a_out')._variants=['Replacement'];r.w.useGen(0,'a');r.read("D.content='Edited while confirming'");r.w.document.querySelector('#ask_yes').click();assert.equal(r.read('D.content'),'Edited while confirming');}finally{r.close();}
});

test('rewrite selection stays bound to its result after another generator updates global variants',async()=>{
 const r=runtime();try{await settle();r.w.go('ai');await settle();r.w.document.querySelector('#rw_in').value='Rewrite source';r.read("AI.call=async kind=>kind==='generate'?'Other generator output':'Rewritten output'");await r.w.runRw('improve');const out=r.w.document.querySelector('#rw_out');assert.deepEqual([...out._variants],['Rewritten output']);r.w.document.querySelector('#a_topic').value='Other topic';await r.w.runGen('a');assert.equal(r.w._gen[0],'Other generator output');out.querySelector('button').click();assert.equal(r.read('D.content'),'Rewritten output');}finally{r.close();}
});

test('rewrite blocks duplicate requests and discards responses after form, page or output changes',async()=>{
 for(const change of ['form','page','output']){const pending=deferred(),r=runtime();try{await settle();r.w.go('ai');await settle();r.w.document.querySelector('#rw_in').value='Source';let calls=0;r.w.pendingRewrite=()=>{calls++;return pending.promise;};r.read('AI.call=()=>window.pendingRewrite()');const out=r.w.document.querySelector('#rw_out'),buttons=[...r.w.document.querySelectorAll('button[onclick^="runRw("]')];const request=r.w.runRw('improve');await r.w.runRw('adapt');assert.equal(calls,1);assert.ok(buttons.every(b=>b.disabled));if(change==='form')r.w.document.querySelector('#rw_in').value='Edited';if(change==='page')r.w.go('create');if(change==='output')out.replaceWith(out.cloneNode(false));pending.resolve('Stale rewrite');await request;assert.equal(out._variants,undefined);assert.ok(buttons.filter(b=>b.isConnected).every(b=>!b.disabled));assert.doesNotMatch(r.w.document.querySelector('#view').textContent,/Stale rewrite/);}finally{r.close();}}
});

test('AI plan ignores duplicate requests and results from a replaced plan or screen',async()=>{
 for(const change of ['plan','screen']){
  const pending=deferred(),r=runtime();
  try{
   await settle();r.w.go('ai');r.w.runPlan();
   let calls=0;
   r.w.pendingPlan=()=>{calls++;return pending.promise;};
   r.read('AI.call=()=>window.pendingPlan()');
   const out=r.w.document.querySelector('#pl_out');
   const request=r.w.planUse(0);
   await r.w.planUse(1);
   assert.equal(calls,1);
   assert.ok([...out.querySelectorAll('button')].every(button=>button.disabled));
   if(change==='plan')r.w.runPlan();
   else r.w.go('library');
   pending.resolve('Stale plan result');await request;
   assert.equal(r.read('D.content'),'');
   assert.equal(r.read('route'),change==='plan'?'ai':'library');
   assert.equal(r.w.document.querySelector('#ask_yes'),null);
  }finally{r.close();}
 }
});

test('AI plan lets the user retry and saves the completed draft with its suggested time',async()=>{
 const r=runtime();
 try{
  await settle();r.w.go('ai');r.w.runPlan();
  r.read('AI.call=async()=>{throw Error("Unavailable")}');
  await r.w.planUse(0);
  const out=r.w.document.querySelector('#pl_out');
  assert.match(out.querySelector('[role="status"]').textContent,/thử lại/);
  assert.ok([...out.querySelectorAll('button')].every(button=>!button.disabled));
  r.read('AI.call=async()=>"Planned post"');
  await r.w.planUse(0);
  assert.equal(r.read('route'),'create');
  assert.equal(r.read('loadDraft().content'),'Planned post');
  assert.equal(r.read('loadDraft().time'),'11:30');
  assert.equal(r.read('loadDraft().when'),'later');
 }finally{r.close();}
});

test('AI plan confirmation preserves changes made to the draft while the dialog is open',async()=>{
 const r=runtime();
 try{
  await settle();edit(r,'Existing draft');r.w.go('ai');r.w.runPlan();
  r.read('AI.call=async()=>"Planned post"');
  await r.w.planUse(0);
  r.read('D.time="18:00"');
  r.w.document.querySelector('#ask_yes').click();
  assert.equal(r.read('route'),'ai');
  assert.equal(r.read('D.content'),'Existing draft');
  assert.equal(r.read('D.time'),'18:00');
 }finally{r.close();}
});

test('text prompt input has the passed dialog title as its accessible name',async()=>{
 const r=runtime();try{await settle();const title='Tên mới cho shop';r.w.askText(title,'Shop A',()=>{});await settle();assert.equal(r.w.document.querySelector('#ask_in').getAttribute('aria-label'),title);assert.equal(r.w.document.querySelector('#ask_in').value,'Shop A');}finally{r.close();}
});

test('every managed screen renders its shared hierarchy without triggering writes',async()=>{
 const readAPI=(path)=>path.includes('/google/accounts')?Response.json({configured:false,accounts:[]}):path.includes('/google/uploads')?Response.json({uploads:[]}):Response.json({shops:[],defaultShopId:null,admin:false,roles:{}});
 const r=runtime({api:readAPI,fetchImpl:async(path)=>path==='/session'?Response.json(session):path==='/channels'?Response.json({channels:[],setup:{zalo:{configured:false,canConnect:false}}}):path==='/channels/all/accounts'?Response.json({accounts:[]}):path==='/channels/all/jobs'?Response.json({jobs:[]}):path==='/channels/all/providers'?Response.json({facebook:{enabled:false},instagram:{enabled:false},telegram:{enabled:false}}):Response.json({})});
 try{await settle();r.w.HTMLCanvasElement.prototype.getContext=()=>new Proxy({measureText:()=>({width:0})},{get:(target,key)=>key in target?target[key]:()=>{}});const routes=r.read('Object.keys(SCREEN_META)');assert.equal(routes.length,17);for(const route of routes){r.w.go(route);await settle();await settle();assert.equal(r.w.document.querySelector('#view').dataset.screen,route);assert.ok(r.w.document.querySelector('#view h2'),route+' needs a clear screen heading');}assert.deepEqual(r.errors,[]);assert.equal(r.requests.filter(x=>['POST','PUT','PATCH','DELETE'].includes(x.method)).length,0);}finally{r.close();}
});

test('password fields have explicit visible labels and decoration preserves entered values',async()=>{
 const r=runtime();try{await settle();r.w.go('settings');await settle();for(const [id,title] of [['pw_cur','Mật khẩu hiện tại'],['pw_new','Mật khẩu mới'],['pw_confirm','Nhập lại mật khẩu mới']]){const input=r.w.document.getElementById(id);assert.ok(input.labels.length);assert.ok([...input.labels].some(label=>label.textContent.startsWith(title)));input.value='Unsaved password';r.w.decorateProductScreen();assert.equal(r.w.document.getElementById(id),input);assert.equal(input.value,'Unsaved password');}assert.equal(r.requests.filter(x=>['POST','PUT','PATCH','DELETE'].includes(x.method)).length,0);}finally{r.close();}
});

test('composer channel and both asset views explicitly name selection checkboxes with escaped item names',async()=>{
 const r=runtime();try{await settle();const name='Shop "A" <sample> & friends';r.w.fixtureName=name;r.read("S.channels=[{id:'label-channel',pf:'facebook',name:window.fixtureName,handle:'@test',connected:true}];D.channels=['label-channel'];S.assets=[{id:'label-asset',name:window.fixtureName,kind:'text',text:'Local content',created:Date.now(),size:12,source:'manual',tags:[],folder:null}];LB.sel.add('label-asset')");r.w.go('create');await settle();const checkbox=r.w.document.querySelector('#chlist input[type=checkbox]');assert.equal(checkbox.getAttribute('aria-label'),'Chọn kênh '+name+' (Facebook)');assert.equal(checkbox.checked,true);const editor=r.w.document.querySelector('#ct');r.w.decorateProductScreen();assert.equal(r.w.document.querySelector('#ct'),editor);for(const mode of ['grid','table']){r.read("LB.view='"+mode+"'");r.w.go('library');await settle();const item=r.w.document.querySelector('#view input[aria-label^="Chọn tài nguyên"]');assert.ok(item,mode);assert.equal(item.getAttribute('aria-label'),'Chọn tài nguyên '+name);assert.equal(item.checked,true);assert.equal(r.w.document.querySelector('#view sample'),null);}assert.equal(r.read('D.channels[0]'),'label-channel');assert.equal(r.read('S.assets[0].text'),'Local content');assert.equal(r.requests.filter(x=>['POST','PUT','PATCH','DELETE'].includes(x.method)).length,0);}finally{r.close();}
});

test('video scene text and duration controls have distinct scene names without changing project data',async()=>{
 const r=runtime();try{await settle();r.w.HTMLCanvasElement.prototype.getContext=()=>new Proxy({measureText:()=>({width:0}),createLinearGradient:()=>({addColorStop:()=>{}})},{get:(target,key)=>key in target?target[key]:()=>{}});r.read("VP=vNewProject();VP.scenes=[{id:'scene-one',text:'Opening text',d:3},{id:'scene-two',text:'Closing text',d:4,cta:true}]");const before=r.read('JSON.stringify(VP)');r.w.go('video');await settle();const fields=[...r.w.document.querySelectorAll('.vscene textarea')];assert.deepEqual(fields.map(f=>f.getAttribute('aria-label')),['Nội dung cảnh 1','Nội dung cảnh 2']);assert.deepEqual(fields.map(f=>f.value),['Opening text','Closing text']);assert.deepEqual([...r.w.document.querySelectorAll('.vscene input[type=number]')].map(f=>f.getAttribute('aria-label')),['Thời lượng cảnh 1 (giây)','Thời lượng cảnh 2 (giây)']);r.w.decorateProductScreen();assert.equal(r.w.document.querySelector('.vscene textarea'),fields[0]);assert.equal(r.read('JSON.stringify(VP)'),before);assert.equal(r.requests.filter(x=>['POST','PUT','PATCH','DELETE'].includes(x.method)).length,0);}finally{r.close();}
});

test('Publishing report shows the newest selected period from the server',async()=>{
 const delayed=deferred(),calls=[];
 const r=runtime({api:async(path,options)=>{
  if(path==='/api/social/jobs/summary'){
   calls.push(options.headers['X-ShopPost-Shop']);
   if(calls.length===1)return delayed.promise;
   return Response.json({days:7,rows:[{provider:'telegram',status:'sent',count:4}]});
  }
  return Response.json({shops:[],defaultShopId:null,roles:{}});
 }});
 try{
  await settle();r.read("SHOP.ready=true;SHOP.id='s_aaaaaaaaaa';SHOP.permissions=['reports.view']");
  r.w.go('analytics');
  const period=r.w.document.querySelector('#publish_report_period');
  period.value='7';period.dispatchEvent(new r.w.Event('change'));
  await settle();
  const out=r.w.document.querySelector('#publish_report_result');
  assert.match(out.textContent,/TelegramĐã đăng4/);
  delayed.resolve(Response.json({days:30,rows:[{provider:'facebook',status:'sent',count:15}]}));
  await settle();
  assert.doesNotMatch(out.textContent,/Facebook/);
  assert.deepEqual(calls,['s_aaaaaaaaaa','s_aaaaaaaaaa']);
 }finally{r.close();}
});

test('Opening analytics directly loads reports once the shop is ready',async()=>{
 const pending=deferred();
 const r=runtime({route:'analytics',api:async path=>{
  if(path==='/api/shops')return pending.promise;
  if(path==='/api/social/jobs/summary')return Response.json({days:30,rows:[]});
  if(path==='/api/social/google/accounts')return Response.json({accounts:[{id:'yt-test',name:'ShopTrack TV',status:'connected'}]});
  return Response.json({});
 }});
 try{
  assert.match(r.w.document.querySelector('#youtube_report_status').textContent,/Đang tải thông tin shop/);
  pending.resolve(Response.json(shopsBody('s_bbbbbbbbbb')));
  await settle();await settle();
  assert.equal(r.w.document.querySelector('#youtube_report_account').value,'yt-test');
  assert.equal(r.w.document.querySelector('#youtube_report_load').hidden,false);
  assert.match(r.w.document.querySelector('#publish_report_status').textContent,/Chưa có lượt đăng/);
 }finally{r.close();}
});
