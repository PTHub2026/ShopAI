import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
const source=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const scope='a'.repeat(64);
const session={userScope:scope,capabilities:{ai:true,drafts:true,publishing:false,scheduling:false,inbox:false}};
const envelope=(id='cloud-a',content='Đã lưu từ thiết bị khác',revision=1)=>({draft:{id,type:'post',content,channels:[],status:'draft',media:[],assets:[],custom:{}},revision,updatedAt:1000});
// api: mock cho /api/* (shop, thành viên, lời mời); mặc định trả tài khoản chưa có shop để các mock bản nháp cũ không bị lẫn yêu cầu khởi động.
function runtime({managed=true,fetchImpl,stored={},api,invite=''}={}) {
  const requests=[],errors=[];
  const html=managed?source.replace('<head>','<head><meta name="shopai-ai-endpoint" content="/ai"><meta name="shopai-user-scope" content="'+scope+'">'+(invite?'<meta name="shoppost-invite" content="'+invite+'">':'')):source;
  const dom=new JSDOM(html,{url:'https://app.example/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:new VirtualConsole(),beforeParse(w){
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
 const r=runtime({fetchImpl:async(path)=>path==='/channels/zalo/publish'?Response.json({job:{id:'pj_retry',status:'retryable',kind:'photo',attempts:1},retryAfter:30},{status:429}):Response.json(session)});
 try{await settle();r.read("SHOP.ready=true;SHOP.id='shop';S.channels=[{id:'real_zalo',pf:'zalo',real:true,provider:'zalo',connected:true}];D.content='Queued content';D.channels=['real_zalo'];D.media=[{type:'image/jpeg',thumb:'data:image/jpeg;base64,/9j/AA==',name:'cover',size:4}]");
 await r.w.submitPostReal(['real_zalo']);assert.equal(r.read('S.posts[0].schedId'),'pj_retry');assert.equal(r.read('S.posts[0].status'),'scheduled');
 r.w.applyPublishJobs([{id:'pj_retry',status:'sent',kind:'photo',attempts:2}],'shop');assert.equal(r.read('S.posts[0].status'),'published');
 }finally{r.close();}
});

const channelFixture=(extra={})=>({accounts:[],jobs:[],channels:[],facebook:{enabled:false},setup:{zalo:{configured:false,canConnect:false}},...extra});
test('social requests carry account scope; accounts waits for shops and ignores obsolete loads',async()=>{
 const r=runtime();try{
  await settle();r.w.eval("go('accounts')");await settle();
  assert.equal(r.requests.filter(x=>x.path==='/channels/all/accounts').length,0);
  const slow=deferred();let pending=true;
  r.w.fetch=async(url,options)=>{assert.equal(options.headers['X-ShopAI-User-Scope'],scope);return pending?slow.promise:Response.json(channelFixture())};
  r.w.eval("SHOP.ready=true;SHOP.id='shop_old';socialAccountsLive()");
  r.w.eval("SHOP.id='shop_new'");pending=false;await r.w.socialAccountsLive();
  const current=r.w.document.querySelector('#view').innerHTML;
  slow.resolve(Response.json(channelFixture({accounts:[{id:'old',name:'Stale',status:'error'}]})));await settle();await settle();
  assert.equal(r.w.document.querySelector('#view').innerHTML,current);
  r.w.eval("go('settings')");const settings=r.w.document.querySelector('#view').innerHTML;await r.w.socialAccountsLive();assert.equal(r.w.document.querySelector('#view').innerHTML,settings);
 }finally{r.close()}
});
test('social pending keys belong to shop and immutable content, and history retires sent jobs',async()=>{
 const r=runtime();try{await settle();r.w.confirm=()=>true;let first=true;const keys=[];
 r.w.fetch=async(url,options)=>{const path=String(url);if(path.endsWith('/retry'))return Response.json({job:{id:'job1',status:'sent'}});keys.push(options.headers['Idempotency-Key']);if(first){first=false;return Response.json({error:'rate_limited',job:{id:'job1',status:'retryable'}},{status:429})}return Response.json({job:{id:'job2',status:'sent',remoteMessageId:'2'}})};
 r.w.eval("SHOP.ready=true;SHOP.id='shop1'");
 const form=text=>{r.w.document.querySelector('#view').innerHTML='<select id="tg_account"><option value="a">A</option></select><textarea id="tg_text"></textarea><input id="tg_photo">';r.w.document.querySelector('#tg_text').value=text};
 form('one');await r.w.socialPublishTelegram();form('two');await r.w.socialPublishTelegram();assert.notEqual(keys[0],keys[1]);
 await r.w.socialRetryTelegram('job1');form('one');await r.w.socialPublishTelegram();assert.notEqual(keys[0],keys[2]);
 }finally{r.close()}
});

test('social history retires keys after a lost response and keeps error accounts disconnectable',async()=>{
 const r=runtime();try{await settle();r.w.eval("SHOP.ready=true;SHOP.id='shop1'");r.w.confirm=()=>true;let key;
 r.w.fetch=async(url,options)=>{key=options.headers['Idempotency-Key'];throw Error('response lost')};
 r.w.document.querySelector('#view').innerHTML='<select id="tg_account"><option value="a">A</option></select><textarea id="tg_text">Lost</textarea><input id="tg_photo">';
 await r.w.socialPublishTelegram();assert.equal(r.read('socialPending.size'),1);
 r.w.fetch=async url=>Response.json(channelFixture({accounts:[{id:'a',name:'Denied',status:'error',targetId:'1'}],jobs:[{id:'sent',status:'sent',idempotencyKey:key,kind:'text',attempts:1}]}));
 r.w.eval("go('accounts')");await settle();await settle();
 assert.equal(r.read('socialPending.size'),0);assert.ok(r.w.document.querySelector('[onclick="socialDisconnectTelegram(\'a\')"]'));
 }finally{r.close()}
});

test('accounts initialization restores the saved shop and stale errors cannot replace another view',async()=>{
 const init=deferred();const saved='s_'+'b'.repeat(32),fallback='s_'+'a'.repeat(32);const calls=[];
 const r=runtime({stored:{['pdk_shop:'+scope]:saved},api:async()=>init.promise,fetchImpl:async(path,options)=>{if(path.startsWith('/channels/'))calls.push(options.headers['X-ShopPost-Shop']);return Response.json(channelFixture())}});
 try{r.w.localStorage.setItem('pdk_shop:'+scope,saved);r.w.eval("go('accounts')");assert.equal(calls.length,0);init.resolve(Response.json({shops:[{id:fallback,name:'Default',role:'owner'},{id:saved,name:'Saved',role:'owner'}],defaultShopId:fallback}));await settle();await settle();assert.ok(calls.length>=4);assert.ok(calls.every(id=>id===saved));
 const slow=deferred();r.w.fetch=()=>slow.promise;r.w.socialAccountsLive();r.w.eval("go('settings')");const page=r.w.document.querySelector('#view').innerHTML;slow.resolve(Response.json({error:'old error'},{status:500}));await settle();await settle();assert.equal(r.w.document.querySelector('#view').innerHTML,page);
 }finally{r.close()}
});

test('late social mutation completion preserves a newer accounts form',async()=>{
 const r=runtime();try{await settle();r.w.eval("SHOP.ready=true;SHOP.id='shop1';go('accounts')");await settle();
 const slow=deferred();r.w.fetch=(url,options)=>options.method==='POST'?slow.promise:Promise.resolve(Response.json(channelFixture()));r.w.document.querySelector('#view').innerHTML='<input id="tg_token" value="token"><input id="tg_chat" value="@channel">';
 const saving=r.w.socialConnectTelegram();r.w.eval("go('settings');go('accounts')");await settle();await settle();r.w.document.querySelector('#view').innerHTML='<textarea id="tg_text">New unsaved form</textarea>';
 slow.resolve(Response.json({ok:true}));await saving;await settle();assert.equal(r.w.document.querySelector('#tg_text')?.value,'New unsaved form');
 }finally{r.close()}
});

test('pending submissions isolate identical content by shop and live history retires lost responses',async()=>{
 const r=runtime();try{await settle();r.w.confirm=()=>true;const keys=[];
 r.w.fetch=async(url,options)=>{keys.push(options.headers['Idempotency-Key']);throw Error('lost')};
 const form=()=>{r.w.document.querySelector('#view').innerHTML='<select id="tg_account"><option value="a" data-provider="zalo">A</option></select><textarea id="tg_text">Same</textarea><input id="tg_photo" value="https://example.com/a.jpg">'};
 r.read("SHOP.ready=true;SHOP.id='one'");form();await r.w.socialPublishTelegram();
 r.read("SHOP.id='two'");form();await r.w.socialPublishTelegram();assert.notEqual(keys[0],keys[1]);
 r.read("SHOP.id='one'");form();await r.w.socialPublishTelegram();assert.equal(keys[2],keys[0]);
 r.w.applyPublishJobs([{id:'lost',status:'sent',idempotencyKey:keys[0],kind:'photo',attempts:1}],'one');
 form();await r.w.socialPublishTelegram();assert.notEqual(keys[3],keys[0]);assert.equal(r.read('socialPending.size'),2);
 }finally{r.close()}
});
test('same-shop obsolete loads and channel initialization cannot erase current accounts input',async()=>{
 const r=runtime();try{await settle();r.read("SHOP.ready=true;SHOP.id='one';go('accounts')");await settle();
 const slow=deferred();let waiting=true;
 r.w.fetch=async()=>waiting?slow.promise:Response.json(channelFixture({accounts:[{id:'new',name:'Newest',status:'active'}]}));
 const old=r.w.socialAccountsLive();waiting=false;await r.w.socialAccountsLive();
 assert.match(r.w.document.querySelector('#view').textContent,/Newest/);
 slow.resolve(Response.json(channelFixture({accounts:[{id:'old',name:'Obsolete',status:'active'}]})));await old;
 assert.doesNotMatch(r.w.document.querySelector('#view').textContent,/Obsolete/);
 const channel=deferred();r.w.fetch=()=>channel.promise;const loading=r.w.channelsLoad();
 r.w.document.querySelector('#tg_text').value='Keep this';channel.resolve(Response.json(channelFixture()));await loading;
 assert.equal(r.w.document.querySelector('#tg_text').value,'Keep this');
 }finally{r.close()}
});

test('switching shops refreshes composer channel controls without replacing the draft',async()=>{
 const r=runtime();try{await settle();const pending=deferred();
 r.w.fetch=async url=>new URL(url,r.w.location.href).pathname==='/channels'?pending.promise:Response.json({error:'stop polling'},{status:403});
 r.read("SHOP.ready=true;SHOP.id='one';SHOP.shops=[{id:'one',name:'One',role:'owner'},{id:'two',name:'Two',role:'owner'}];go('create');shopSwitch('two');stopJobWatch()");
 const editor=r.w.document.querySelector('#ct');editor.value='Keep my draft';editor.dispatchEvent(new r.w.Event('input'));r.read("D.channels=['real_zalo']");
 assert.doesNotMatch(r.w.document.querySelector('#chlist').textContent,/New OA/);
 pending.resolve(Response.json({channels:[{provider:'zalo',status:'connected',name:'New OA',oa_id:'12345'}]}));await settle();await settle();
 assert.match(r.w.document.querySelector('#chlist').textContent,/New OA/);
 assert.equal(r.w.document.querySelector('#ct'),editor);assert.equal(editor.value,'Keep my draft');
 assert.equal(r.w.document.querySelector('#sub').disabled,false);
 }finally{r.close()}
});
