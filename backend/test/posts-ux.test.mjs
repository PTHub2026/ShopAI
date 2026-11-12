import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const section=source.slice(source.indexOf('const F={posts:'),source.indexOf('/* =================',source.indexOf('function newAt(')));
function runtime(managed=true){
 const view={innerHTML:''},state={posts:[],channels:[{id:'c',pf:'facebook',connected:false,real:true}],groups:[]},calls={};
 const ctx=vm.createContext({S:state,V:{},URL,Date,console,managedApp:()=>managed,$:()=>view,esc:s=>String(s).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;'),escAttr:s=>s,PF:{facebook:{n:'Facebook'}},chById:id=>state.channels.find(c=>c.id===id),grpById:()=>null,pfIcon:()=>'',fmtT:()=>'',fmtN:String,toast:s=>calls.toast=s,ask:(message,cb,opts)=>{calls.ask={message,cb,opts}},save:()=>calls.saved=true,render:()=>calls.rendered=true,freshDraft:fn=>fn(),D:{},go:()=>{}});
 vm.runInContext(section,ctx);return {state,calls,run:s=>vm.runInContext(s,ctx),view};
}
const post=(extra={})=>({id:'p',status:'published',channels:['c'],content:'Nội dung',time:Date.now(),metrics:{c:{views:0,likes:0,comments:0,shares:0}},...extra});
test('managed cards omit fabricated zero metrics and safely show verified links',()=>{
 const r=runtime();r.state.posts=[post({jobs:[{provider:'facebook',status:'sent',remoteMessageId:'123_456'}]})];
 const html=r.run('postCard(S.posts[0])');assert.match(html,/Chưa có số liệu/);assert.doesNotMatch(html,/0 lượt xem|0.00%/);assert.match(html,/https:\/\/www.facebook.com\/123_456/);assert.match(html,/noopener noreferrer/);
 for(const url of ['javascript:alert(1)','https://facebook.com.evil.example/x','https://user:pass@facebook.com/x','http://facebook.com/x']){r.state.posts=[post({url})];assert.doesNotMatch(r.run('postCard(S.posts[0])'),/Mở bài trên nền tảng/);}
});
test('active or uncertain server work stays visible even through direct deletion calls',()=>{
 const r=runtime();for(const extra of [{status:'scheduled'},{status:'processing'},{status:'unknown'},{status:'failed',jobs:[{status:'pending'}]},{status:'published',jobs:[{status:'unknown'}]}]){
 r.state.posts=[post(extra)];r.run("delPost('p')");assert.equal(r.state.posts.length,1);assert.equal(r.calls.ask,undefined);assert.match(r.run('postCard(S.posts[0])'),/disabled title/);
 }
});
test('history deletion describes platform scope and rechecks state before confirmation',()=>{
 const r=runtime();r.state.posts=[post()];r.run("delPost('p')");assert.match(r.calls.ask.message,/Bài trên nền tảng vẫn còn/);r.state.posts[0].status='processing';r.calls.ask.cb();assert.equal(r.state.posts.length,1);
 r.state.posts[0].status='published';r.run("delPost('p')");r.calls.ask.cb();assert.equal(r.state.posts.length,0);assert.equal(r.calls.saved,true);
});
test('unknown and processing filters and calendar describe records and draft action',()=>{
 const r=runtime();r.state.posts=[post({status:'unknown'}),post({id:'p2',status:'processing'})];assert.match(r.run("filterBar('posts')"),/value="unknown"/);assert.match(r.run("filterBar('calendar')"),/value="processing"/);assert.match(r.run("filterBar('posts')"),/value="facebook"/);
 assert.equal(r.run("F.posts.status='unknown';fpost('posts').length"),1);assert.equal(r.run("F.posts.status='processing';fpost('posts')[0].id"),'p2');
 r.run('V.calendar()');assert.match(r.view.innerHTML,/bài chỉ được lên lịch khi bạn xác nhận/);assert.match(r.view.innerHTML,/Cần kiểm tra kết quả/);
 r.state.posts=[];r.run('V.posts()');assert.match(r.view.innerHTML,/Chưa có lịch sử đăng bài/);r.run('V.calendar()');assert.match(r.view.innerHTML,/Chưa có bài trong khoảng/);
});
test('offline simulated schedule can still be deleted locally',()=>{const r=runtime(false);r.state.posts=[post({status:'scheduled'})];r.run("delPost('p')");r.calls.ask.cb();assert.equal(r.state.posts.length,0);r.state.posts=[post()];assert.match(r.run('postCard(S.posts[0])'),/lượt xem/);});
