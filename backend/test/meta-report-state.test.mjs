import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM,VirtualConsole} from 'jsdom';
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const settle=()=>new Promise(r=>setImmediate(r));
function runtime(){const dom=new JSDOM(html,{url:'https://app.example/',runScripts:'dangerously',virtualConsole:new VirtualConsole(),beforeParse(w){w.scrollTo=()=>{};}});const w=dom.window;w.eval("managedApp=()=>true;SHOP.ready=true;SHOP.id='s_abcdefgh';SHOP.permissions=['reports.view'];cloudRequest=async p=>p.includes('engagement')?{rows:[],fetchedAt:100}:p.includes('summary')?{days:30,rows:[]}:{accounts:[]};go('analytics')");return {w,run:s=>w.eval(s),q:s=>w.document.querySelector(s),close:()=>w.close()};}
test('Meta result survives revisiting analytics and never disappears into a blank state',async()=>{const r=runtime();try{r.q('#meta_report_load').click();await settle();assert.match(r.q('#meta_report_status').textContent,/Chưa có bài/);r.run("go('create');go('analytics')");await settle();assert.match(r.q('#meta_report_status').textContent,/Chưa có bài/);}finally{r.close();}});
test('Meta error remains actionable after revisiting and is isolated by shop',async()=>{const r=runtime();try{r.run("cloudRequest=async()=>{throw Object.assign(Error('denied'),{status:403})}");r.q('#meta_report_load').click();await settle();r.run("go('create');go('analytics')");assert.match(r.q('#meta_report_status').textContent,/quyền/);r.run("SHOP.id='s_otherabc';go('analytics')");assert.doesNotMatch(r.q('#meta_report_status').textContent,/Chưa tải được|denied/);assert.ok(r.q('#meta_report_status').textContent.trim());}finally{r.close();}});
test('Feedback reload preserves the unfinished form and isolates it by shop',async()=>{
 const r=runtime();try{
  r.run("cloudRequest=async()=>({items:[],cursor:null,canManage:true,canCreate:true});go('feedback')");await settle();
  r.q('#fb_title').value='Nội dung đang nhập';r.q('#fb_desc').value='Không được mất khi tải lại';r.q('#fb_tech').checked=false;
  await r.run('serverFeedbackLoad()');
  assert.equal(r.q('#fb_title').value,'Nội dung đang nhập');assert.equal(r.q('#fb_desc').value,'Không được mất khi tải lại');assert.equal(r.q('#fb_tech').checked,false);
  r.run("SHOP.id='s_anothershop';go('feedback')");await settle();assert.equal(r.q('#fb_title').value,'');
 }finally{r.close();}
});
test('Manual reply unlocks a definite rejection but retains an ambiguous attempt',async()=>{
 const r=runtime();try{
  r.run("SHOP.permissions=['conversations.reply'];LIVEIN.shop=SHOP.id;LIVEIN.selected='c_1';LIVEIN.conversation={provider:'zalo'};liveInboxDraw=()=>{$('#view').innerHTML=liveReplyComposer(LIVEIN.conversation,LIVEIN.busy)};liveReplyEdit('Xin chào khách');liveInboxDraw();cloudRequest=async()=>{throw Object.assign(Error('Hết hạn'),{code:'response_window_expired'})}");
  await r.run('liveReplySend()');assert.equal(r.run('liveReplyDraft().id'),null);assert.equal(r.q('#live_reply').disabled,false);assert.equal(r.q('#live_reply').value,'Xin chào khách');
  r.run("cloudRequest=async()=>{throw Object.assign(Error('Chưa rõ'),{deliveryStatus:'unknown'})}");await r.run('liveReplySend()');
  const id=r.run('liveReplyDraft().id');assert.ok(id);assert.equal(r.q('#live_reply').disabled,true);
  r.run("cloudRequest=async()=>{throw Object.assign(Error('Permission revoked'),{code:'forbidden'})}");await r.run('liveReplySend()');assert.equal(r.run('liveReplyDraft().id'),id);
  r.run('LIVEIN.busy=true;liveReplyResolve()');assert.equal(r.run('liveReplyDraft().id'),id);r.run('LIVEIN.busy=false');
  r.run('ask=(message,action)=>action();liveReplyResolve()');assert.equal(r.q('#live_reply').value,'');assert.equal(r.q('#live_reply').disabled,false);
 }finally{r.close();}
});
test('Queue updates retain loaded history pages and ask for an explicit refresh',()=>{
 const r=runtime();try{
  r.run("route='posts';S.posts=[];CAL.shop=SHOP.id;CAL.rows=[{id:'a',status:'scheduled'},{id:'b',status:'published'}];CAL.cursor='next-page';scheduledLoad=()=>{throw Error('Unexpected pagination reset')};render=()=>{};applyPublishJobs([{id:'a',status:'sent'},{id:'unloaded',status:'sent'}],SHOP.id)");
  assert.equal(r.run('CAL.rows.length'),2);assert.equal(r.run('CAL.rows[0].status'),'published');assert.equal(r.run('CAL.cursor'),'next-page');assert.equal(r.run('CAL.refreshNeeded'),true);
 }finally{r.close();}
});
