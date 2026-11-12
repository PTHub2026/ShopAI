import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
function runtime(fetchImpl, qa=false) {
  const notices=[];
  const context=vm.createContext({URL,AbortSignal,Response, location:{href:'https://app.example/',origin:'https://app.example'},window:{QA_RUNNING:qa}, S:{settings:{brand:'ShopTrack'}},document:{querySelector:()=>({content:'/ai'})},toast:m=>notices.push(m),setTimeout});
  vm.runInContext(html.slice(html.indexOf('const managedAIEndpoint='),html.indexOf('function contentScore('))+';globalThis.api=AI;',context);
  context.aiConnectionStatus=m=>notices.push(m);
  context.fetch=fetchImpl;
  context.api.local.reply=()=> 'Mẫu offline';
  return {context,notices};
}
test('Lỗi AI không được biến thành mẫu nội bộ thành công',async()=>{
  for(const response of [new Response('{}',{status:502}),new Response('<html>Login</html>',{headers:{'content-type':'text/html'}}),new Response('{"text":" "}',{headers:{'content-type':'application/json'}})]){
    const {context}=runtime(async()=>response);
    await assert.rejects(context.api.call('reply',{text:'Xin chào'}));
  }
});
test('QA dùng mẫu riêng và không gọi mạng',async()=>{
  const {context}=runtime(()=>{throw Error('Unexpected network')},true);
  assert.equal(await context.api.call('reply',{text:'Xin chào'}),'Mẫu offline');
});
test('Kết quả AI thật đi qua endpoint cùng origin',async()=>{
  let sent;
  const {context}=runtime(async(url,options)=>{sent={url,...options};return new Response('{"text":"Trả lời thật"}',{headers:{'content-type':'application/json'}})});
  assert.equal(await context.api.call('reply',{text:'Xin chào',task:'invalid'}),'Trả lời thật');
  assert.equal(sent.url,'https://app.example/ai');assert.equal(sent.credentials,'same-origin');assert.equal(JSON.parse(sent.body).task,'reply');
});
test('Cải thiện lỗi giữ nguyên bản nháp và khôi phục nút',async()=>{
  const original='một hai ba bốn năm sáu bảy tám chín mười mười một mười hai mười ba mười bốn mười lăm';
  const button={textContent:'Cải thiện',disabled:false},input={value:original};
  const context=vm.createContext({AI:{call:async()=>{throw Error('Offline')}},D:{content:original},S:{settings:{}},$:s=>s==='#impBtn'?button:input,upd:()=>{},toast:()=>{}});
  vm.runInContext('let improveInFlight=false;'+html.slice(html.indexOf('async function aiImprove()'),html.indexOf('function submitPost()')),context);
  await context.aiImprove();
  assert.equal(context.D.content,original);assert.equal(input.value,original);assert.equal(button.disabled,false);assert.ok(!button.textContent.includes('Đang'));
});
test('Kết quả không còn tồn tại không được phá bản nháp',()=>{
  const context=vm.createContext({window:{_gen:[]},D:{content:'Bản nháp cần giữ'},ask:(message,yes)=>yes(),toast:()=>{},closeModal:()=>{},go:()=>{}});
  vm.runInContext(html.slice(html.indexOf('function useGen('),html.indexOf('function openGen(')),context);
  context.useGen(0);assert.equal(context.D.content,'Bản nháp cần giữ');
});
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
test('Cải thiện chỉ cho phép một yêu cầu và giữ nút vô hiệu hóa khi nội dung quá ngắn',async()=>{
  const pending=deferred(),button={disabled:false,textContent:'Cải thiện'},input={value:''},count={textContent:''},submit={};
  const context=vm.createContext({AI:{call:()=>{context.calls++;return pending.promise}},calls:0,D:{content:'một hai ba bốn năm sáu bảy tám chín mười mười một mười hai mười ba mười bốn mười lăm',channels:[],media:[],custom:{}},S:{settings:{tone:'thân thiện'}},$:(selector)=>({'#impBtn':button,'#ct':input,'#cnt':count,'#sub':submit}[selector]),saveDraft:()=>{},renderGrpBar:()=>{},renderCh:()=>{},renderPv:()=>{},renderScore:()=>{},draftDirty:()=>false,validity:()=>'',chById:()=>null,toast:()=>{}});
  vm.runInContext(html.slice(html.indexOf('let improveInFlight='),html.indexOf('function renderCh()'))+html.slice(html.indexOf('async function aiImprove()'),html.indexOf('function submitPost()')),context);
  const first=context.aiImprove();await context.aiImprove();context.upd();
  assert.equal(context.calls,1);assert.equal(button.disabled,true);
  context.D.content='too short';context.upd();pending.resolve('Improved copy');await first;
  assert.equal(context.D.content,'too short');assert.equal(button.disabled,true);
});
test('Gợi ý trả lời không ghi đè bản nháp của hội thoại khác',async()=>{
  const pending=deferred(),draftA={value:'bản nháp A',focus(){}},draftB={value:'bản nháp B',focus(){}},conversations={a:{customer:'A',messages:[{from:'customer',text:'Xin chào'}]},b:{customer:'B',messages:[]}};
  const context=vm.createContext({AI:{call:()=>pending.promise},IB:{sel:'a',role:'agent'},cv:id=>conversations[id],$:(selector)=>selector==='#reply'?(context.IB.sel==='a'?draftA:draftB):null,toast:()=>{},V:{inbox:()=>{} }});
  vm.runInContext(html.slice(html.indexOf('async function aiSuggest('),html.indexOf('function toggleTag(')),context);
  const request=context.aiSuggest('a');context.IB.sel='b';pending.resolve('Reply for A');await request;
  assert.equal(draftB.value,'bản nháp B');
});
test('Caption không bị ghi đè sau chỉnh sửa hoặc chuyển trang',async()=>{
  for(const change of ['edit','navigate']){
    const pending=deferred(),project={topic:'Chủ đề',scenes:[],caption:'caption ban đầu'},input={value:'caption ban đầu'},button={textContent:''};
    let saves=0,renders=0;
    const context=vm.createContext({AI:{call:()=>pending.promise},VP:project,route:'video',SHOP:{id:'shop-a'},S:{settings:{}},$:(selector)=>({'#v_cap':input,'#v_capbtn':button}[selector]),adaptText:text=>text,vSave:()=>saves++,V:{video:()=>renders++},toast:()=>{}});
    vm.runInContext(html.slice(html.indexOf('const VIDEO_CAPTION_BUSY='),html.indexOf('function vSrc(')),context);
    const request=context.vCaption();
    if(change==='edit'){project.caption='caption người dùng';input.value=project.caption}else context.route='create';
    pending.resolve('caption AI');await request;
    assert.equal(project.caption,change==='edit'?'caption người dùng':'caption ban đầu');
    assert.equal(saves,0);assert.equal(renders,0);
  }
});
