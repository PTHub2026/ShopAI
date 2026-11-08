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
function cloudDraftRuntime(fetchImpl, draft={content:'Bản nháp',media:[],channels:['facebook'],custom:{},assets:[],textAssets:[]}) {
  const values=new Map(),notices=[];
  const LS={_mem:false,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value))};
  const context=vm.createContext({
    URL,AbortSignal,Response,TextEncoder,crypto:{randomUUID:()=> 'draft-id'},
    location:{protocol:'https:',href:'https://app.example/',origin:'https://app.example'},
    window:{QA_RUNNING:false},document:{querySelector:()=>({content:'/storage/drafts'})},
    LS,D:draft,newDraft:()=>({content:'',media:[],channels:[],custom:{},assets:[],textAssets:[]}),
    loadDraft:key=>{try{return {...context.newDraft(),...JSON.parse(LS.getItem(key)),media:[]}}catch{return context.newDraft()}},
    saveDraft:()=>{},ask:(message,yes)=>yes(),go:()=>{},loadFiles:async()=>{},route:'create',V:{create:()=>{}},
    $:()=>null,toast:message=>notices.push(message),fetch:fetchImpl
  });
  const start=html.indexOf('const CLOUD_DRAFTS='),end=html.indexOf('/* ================= CREATE POST ================= */',start);
  vm.runInContext(html.slice(start,end)+';globalThis.cloudDraftTests={saveCloudDraft,openCloudDraft,restoreBeforeCloud,CLOUD_DRAFTS};',context);
  return {context,LS,values,notices,draft};
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
  const button={textContent:'Cải thiện',disabled:false},input={value:'Nội dung gốc'};
  const context=vm.createContext({AI:{call:async()=>{throw Error('Offline')}},D:{content:'Nội dung gốc'},S:{settings:{}},$:s=>s==='#impBtn'?button:input,upd:()=>{},toast:()=>{}});
  vm.runInContext(html.slice(html.indexOf('async function aiImprove()'),html.indexOf('function submitPost()')),context);
  await context.aiImprove();
  assert.equal(context.D.content,'Nội dung gốc');assert.equal(input.value,'Nội dung gốc');assert.equal(button.disabled,false);assert.ok(!button.textContent.includes('Đang'));
});
test('Kết quả không còn tồn tại không được phá bản nháp',()=>{
  const context=vm.createContext({window:{_gen:[]},D:{content:'Bản nháp cần giữ'},ask:(message,yes)=>yes(),toast:()=>{},closeModal:()=>{},go:()=>{}});
  vm.runInContext(html.slice(html.indexOf('function useGen('),html.indexOf('function openGen(')),context);
  context.useGen(0);assert.equal(context.D.content,'Bản nháp cần giữ');
});
test('Lưu nháp đám mây thành công tăng revision',async()=>{
  const revisions=[];
  const {context,draft}=cloudDraftRuntime(async(url,options)=>{
    const request=JSON.parse(options.body);revisions.push(request.revision);
    return new Response(JSON.stringify({draft:request.draft,revision:request.revision+1}),{headers:{'content-type':'application/json'}});
  });
  await context.cloudDraftTests.saveCloudDraft();
  await context.cloudDraftTests.saveCloudDraft();
  assert.deepEqual(revisions,[0,1]);
  assert.equal(context.cloudDraftTests.CLOUD_DRAFTS.refs.get(draft).revision,2);
});
test('Lỗi PUT giữ nguyên ID và revision của nháp đám mây',async()=>{
  for(const failure of ['conflict','timeout','mismatch']){
    const fetchImpl=async(url,options)=>{
      if(failure==='conflict')return new Response('{}',{status:409,headers:{'content-type':'application/json'}});
      if(failure==='timeout')throw Object.assign(new Error('timeout'),{name:'TimeoutError'});
      const request=JSON.parse(options.body);
      return new Response(JSON.stringify({draft:request.draft,revision:request.revision+2}),{headers:{'content-type':'application/json'}});
    };
    const {context,draft}=cloudDraftRuntime(fetchImpl);
    const ref={id:'existing-draft',revision:4};
    context.cloudDraftTests.CLOUD_DRAFTS.refs.set(draft,ref);
    await context.cloudDraftTests.saveCloudDraft();
    assert.strictEqual(context.cloudDraftTests.CLOUD_DRAFTS.refs.get(draft),ref);
    assert.equal(ref.id,'existing-draft');
    assert.equal(ref.revision,4);
  }
});
test('Backup lỗi ngăn mở hoặc khôi phục thay nháp hiện tại',()=>{
  for(const flow of ['open','restore']){
    for(const failure of ['write','readback']){
      const {context,LS,values,draft}=cloudDraftRuntime(async()=>{throw new Error('Unexpected network')});
      const backupKey=context.cloudDraftTests.CLOUD_DRAFTS.backupKey;
      values.set(backupKey,JSON.stringify({content:'Bản trước đó',media:[],channels:[]}));
      if(failure==='write')LS.setItem=()=>{throw new Error('storage unavailable')};
      else LS.setItem=(key,value)=>values.set(key,key===backupKey?'{}':String(value));
      if(flow==='open'){
        context.cloudDraftTests.CLOUD_DRAFTS.rows=[{draft:{id:'cloud-draft',type:'post',content:'Bản đám mây',channels:[],status:'draft',media:[],assets:[],custom:{}},revision:1}];
        context.cloudDraftTests.openCloudDraft(0);
      }else context.cloudDraftTests.restoreBeforeCloud();
      assert.strictEqual(context.D,draft);
      assert.equal(context.D.content,'Bản nháp');
    }
  }
});
