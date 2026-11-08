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
function cloudRuntime({fetchImpl=async()=>{throw Error('Unexpected request')},media=[],idb=true,failPut=false,failBackupWrite=false,failBackupReadback=false,backup=null}={}){
  const files=new Map(),stored=new Map(),draft={content:'Bản nháp hiện tại',channels:[],media,custom:{},textAssets:[]};
  let pending;
  const LS={_mem:false,getItem:k=>stored.get(k)??null,setItem:(k,v)=>{if(k==='pdk_draft_before_cloud_v1'&&failBackupWrite)throw Error('Storage unavailable');stored.set(k,k==='pdk_draft_before_cloud_v1'&&failBackupReadback?'{}':v)}};
  const IDB={db:idb?{}:null,get:async(s,k)=>files.get(k)||null,put:async(s,k,v)=>{if(failPut)return null;files.set(k,v);return k}};
  if(backup)stored.set('pdk_draft_before_cloud_v1',JSON.stringify(backup));
  const context=vm.createContext({URL,AbortSignal,Blob,Response,TextEncoder,JSON,WeakMap,LS,IDB,D:draft,window:{QA_RUNNING:false},location:{protocol:'https:',origin:'https://app.example'},document:{querySelector:()=>({content:'/storage/drafts'})},crypto:{randomUUID:()=>'new-cloud-id'},fetch:fetchImpl,toast:()=>{},$:()=>null,ask:(message,yes)=>{pending=Promise.resolve().then(yes)},newDraft:()=>({content:'',channels:[],media:[],custom:{},textAssets:[]}),saveDraft:()=>{},go:()=>{},loadFiles:async()=>{},loadDraft:()=>({content:'Bản sao lưu',channels:[],media:[],custom:{},textAssets:[]}),uid:()=>'new-media-id'});
  const start=html.indexOf('const CLOUD_DRAFTS='),end=html.indexOf('/* ================= CREATE POST ================= */');
  vm.runInContext(html.slice(start,end)+';globalThis.hooks={CLOUD_DRAFTS,saveCloudDraft,openCloudDraft,restoreBeforeCloud,getDraft:()=>D,getRef:d=>CLOUD_DRAFTS.refs.get(d)};',context);
  return {context,files,stored,get pending(){return pending}};
}
const cloudRow=(id='cloud-id',revision=1)=>({draft:{id,type:'post',content:'Nội dung đám mây',channels:[],status:'draft',media:[],assets:[],custom:{}},revision});
function cloudResponse(row){return new Response(JSON.stringify(row),{headers:{'content-type':'application/json'}})}
function cloudSuccess(url,options){const body=JSON.parse(options.body);return cloudResponse({draft:body.draft,revision:body.revision+1})}
test('Lưu đám mây chỉ tăng revision sau phản hồi khớp',async()=>{
  const {context}=cloudRuntime({fetchImpl:async(...args)=>cloudSuccess(...args)});
  await context.hooks.saveCloudDraft();
  assert.deepEqual({...context.hooks.getRef(context.hooks.getDraft())},{id:'new-cloud-id',revision:1});
});
test('409, timeout và phản hồi sai không đổi ID hoặc revision đã xác nhận',async()=>{
  for(const failed of [
    async()=>new Response('{}',{status:409}),
    async()=>{throw Error('timeout')},
    async()=>cloudResponse(cloudRow('cloud-id',9))
  ]){
    let calls=0;
    const {context}=cloudRuntime({fetchImpl:async(...args)=>++calls===1?cloudSuccess(...args):failed()});
    await context.hooks.saveCloudDraft();
    const draft=context.hooks.getDraft(),before={...context.hooks.getRef(draft)};
    await context.hooks.saveCloudDraft();
    assert.deepEqual({...context.hooks.getRef(draft)},{...before});
  }
});
test('Mở và khôi phục đều chặn thay thế nếu sao lưu media thất bại',async()=>{
  const media=[{name:'original.mp4',type:'video/mp4',size:3,fid:'original',file:new Blob(['vid'],{type:'video/mp4'})}];
  for(const options of [{idb:false},{idb:true,failPut:true},{idb:true,failBackupWrite:true},{idb:true,failBackupReadback:true}]){
    const runtime=cloudRuntime({...options,media,backup:{content:'Bản trước',channels:[],media:[],custom:{},textAssets:[]}}),{context}=runtime;
    const current=context.hooks.getDraft();
    context.hooks.CLOUD_DRAFTS.rows=[cloudRow()];
    context.hooks.openCloudDraft(0);
    await runtime.pending;
    assert.equal(context.hooks.getDraft(),current);
    context.hooks.restoreBeforeCloud();
    await runtime.pending;
    assert.equal(context.hooks.getDraft(),current);
  }
});
test('Mở bản đám mây sao lưu và xác minh media gốc trước khi thay thế',async()=>{
  const file=new Blob(['vid'],{type:'video/mp4'});
  const runtime=cloudRuntime({media:[{name:'original.mp4',type:'video/mp4',size:3,fid:'original',file}]}),{context,files,stored}=runtime;
  context.hooks.CLOUD_DRAFTS.rows=[cloudRow()];
  context.hooks.openCloudDraft(0);
  await runtime.pending;
  assert.equal(context.hooks.getDraft().content,'Nội dung đám mây');
  assert.equal(files.get('d_original').size,3);
  assert.equal(JSON.parse(stored.get('pdk_draft_before_cloud_v1')).media[0].fid,'original');
});
