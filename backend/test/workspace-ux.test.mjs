import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM,VirtualConsole} from 'jsdom';
const source=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
function runtime(managed=true){
 const html=managed?source.replace('<head>','<head><meta name="shopai-ai-endpoint" content="/ai">'):source;
 const errors=[],requests=[];
 const dom=new JSDOM(html,{url:'https://app.example/',runScripts:'dangerously',virtualConsole:new VirtualConsole(),beforeParse(w){w.scrollTo=()=>{};w.AbortSignal=AbortSignal;w.TextEncoder=TextEncoder;w.fetch=async url=>{requests.push(url);return Response.json({shops:[],roles:{},capabilities:{}})};w.addEventListener('error',e=>errors.push(e.error));}});
 return {w:dom.window,run:s=>dom.window.eval(s),view:()=>dom.window.document.querySelector('#view'),errors,requests,close:()=>dom.window.close()};
}
test('managed unsupported routes show scope and navigation without live controls or fabricated metrics',()=>{
 const r=runtime();try{for(const route of ['analytics','inbox','response']){r.run(`V.${route}()`);assert.match(r.view().textContent,/chưa hỗ trợ/);assert.match(r.view().innerHTML,/go\('accounts'\)/);assert.equal(r.view().querySelectorAll('input,textarea,select').length,0);assert.doesNotMatch(r.view().innerHTML,/syncMetrics|sendMsg|simIncoming|0%/);}assert.deepEqual(r.errors,[]);}finally{r.close();}
});
test('managed bot permits local planning and simulation while remote activation is disabled',()=>{
 const r=runtime();try{r.run('V.bot()');assert.match(r.view().textContent,/không gửi tin nhắn tới khách hàng/);assert.ok(r.view().querySelector('input[aria-label="Tự động trả lời chưa khả dụng"]').disabled);assert.ok(r.view().querySelector('[onclick="editScript()"]'));const before=r.requests.length;r.run("btSend('xin chào')");assert.ok(r.run('BT.log.length')>=2);assert.equal(r.requests.length,before);assert.match(r.view().textContent,/Mô phỏng cục bộ/);}finally{r.close();}
});
test('offline demo retains inbox composer, reporting and local bot activation',()=>{
 const r=runtime(false);try{r.run('V.inbox()');assert.ok(r.view().querySelector('#reply'));r.run('V.analytics()');assert.match(r.view().innerHTML,/syncMetrics/);r.run('V.response()');assert.ok(r.view().querySelector('select'));r.run('V.bot()');assert.equal(r.view().querySelector('input[type="checkbox"]').disabled,false);r.run("btSend('xin chào')");assert.ok(r.run('BT.log.length')>=2);assert.deepEqual(r.errors,[]);}finally{r.close();}
});
test('local helpers explain persistence and render useful empty collections',()=>{
 const r=runtime();try{r.run('S.groups=[];S.hashtags=[];V.groups()');assert.match(r.view().textContent,/trình duyệt này/);assert.match(r.view().textContent,/Chưa có nhóm/);r.run('V.hashtags()');assert.match(r.view().textContent,/Chưa có bộ hashtag/);r.view().querySelector('#hs_n').value='Bộ thử';r.view().querySelector('#hs_t').value='shop sale';r.run('addHs()');assert.equal(r.run('S.hashtags[0].tags.join(" ")'),'#shop #sale');r.run('V.settings()');assert.match(r.view().textContent,/bản ghi tài khoản, bài đăng được lưu tạm trên trình duyệt này/);assert.match(r.view().textContent,/Xuất hoặc nhập JSON không sao lưu hay khôi phục dữ liệu chính thức trên máy chủ/);assert.doesNotMatch(r.view().textContent,/không nằm trong bản sao lưu/);}finally{r.close();}
});
