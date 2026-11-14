import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM,VirtualConsole} from 'jsdom';
const source=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
test('library search filters while typing and preserves focus and caret',()=>{
 const r=runtime(false);try{
  r.run("S.assets=[{id:'a',name:'Alpha',text:'',tags:[],kind:'text',source:'manual',created:Date.now(),size:0},{id:'b',name:'Beta',text:'',tags:[],kind:'text',source:'manual',created:Date.now(),size:0}];go('library')");
  let input=r.view().querySelector('input[placeholder*="Tìm theo tên"]');input.focus();input.value='Alpha';input.setSelectionRange(2,2);input.dispatchEvent(new r.w.Event('input',{bubbles:true}));
  assert.match(r.view().textContent,/1 kết quả/);assert.doesNotMatch(r.view().textContent,/Beta/);
  input=r.view().querySelector('input[placeholder*="Tìm theo tên"]');assert.equal(r.w.document.activeElement,input);assert.equal(input.selectionStart,2);
  input.value='missing';input.dispatchEvent(new r.w.Event('input',{bubbles:true}));assert.match(r.view().textContent,/0 kết quả/);
  input=r.view().querySelector('input[placeholder*="Tìm theo tên"]');input.value='';input.dispatchEvent(new r.w.Event('input',{bubbles:true}));assert.match(r.view().textContent,/2 kết quả/);assert.deepEqual(r.errors,[]);
 }finally{r.close();}
});
function runtime(managed=true){
 const html=managed?source.replace('<head>','<head><meta name="shopai-ai-endpoint" content="/ai">'):source;
 const errors=[],requests=[];
 const dom=new JSDOM(html,{url:'https://app.example/',runScripts:'dangerously',virtualConsole:new VirtualConsole(),beforeParse(w){w.scrollTo=()=>{};w.AbortSignal=AbortSignal;w.TextEncoder=TextEncoder;w.fetch=async url=>{requests.push(url);return Response.json({shops:[],roles:{},capabilities:{}})};w.addEventListener('error',e=>errors.push(e.error));}});
 return {w:dom.window,run:s=>dom.window.eval(s),view:()=>dom.window.document.querySelector('#view'),errors,requests,close:()=>dom.window.close()};
}
test('managed analytics explains its data scope and never shows fabricated engagement',()=>{
 const r=runtime();try{r.run("go('analytics')");assert.match(r.view().textContent,/Chỉ số video YouTube/);assert.ok(r.view().querySelector('#publish_report_period'));assert.ok(r.view().querySelector('a[href="#posts"]'));assert.doesNotMatch(r.view().innerHTML,/syncMetrics|0%/);assert.deepEqual(r.errors,[]);}finally{r.close();}
});
test('managed bot waits for server configuration and never runs a local simulation',()=>{
 const r=runtime();try{r.run('V.bot()');assert.match(r.view().textContent,/cấu hình đã lưu trên máy chủ/);assert.ok(r.view().querySelector('[onclick="editScript()"]').disabled);const before=r.requests.length;r.run("btSend('xin chào')");assert.equal(r.run('BT.log.length'),0);assert.equal(r.requests.length,before);assert.doesNotMatch(r.view().textContent,/Mô phỏng cục bộ/);}finally{r.close();}
});
test('offline demo retains inbox composer, reporting and local bot activation',()=>{
 const r=runtime(false);try{r.run('V.inbox()');assert.ok(r.view().querySelector('#reply'));r.run('V.analytics()');assert.match(r.view().innerHTML,/syncMetrics/);r.run('V.response()');assert.ok(r.view().querySelector('select'));r.run('V.bot()');assert.equal(r.view().querySelector('input[type="checkbox"]').disabled,false);r.run("btSend('xin chào')");assert.ok(r.run('BT.log.length')>=2);assert.deepEqual(r.errors,[]);}finally{r.close();}
});
test('local helpers explain persistence and render useful empty collections',()=>{
 const r=runtime();try{r.run('S.groups=[];S.hashtags=[];V.groups()');assert.match(r.view().textContent,/trình duyệt này/);assert.match(r.view().textContent,/Chưa có nhóm/);r.run('V.hashtags()');assert.match(r.view().textContent,/Chưa có bộ hashtag/);r.view().querySelector('#hs_n').value='Bộ thử';r.view().querySelector('#hs_t').value='shop sale';r.run('addHs()');assert.equal(r.run('S.hashtags[0].tags.join(" ")'),'#shop #sale');r.run('V.settings()');assert.match(r.view().textContent,/bản ghi tài khoản, bài đăng được lưu tạm trên trình duyệt này/);assert.match(r.view().textContent,/Tệp xuất chỉ chứa dữ liệu đang lưu trên trình duyệt/);assert.doesNotMatch(r.view().textContent,/không nằm trong bản sao lưu/);}finally{r.close();}
});

