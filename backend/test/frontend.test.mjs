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
