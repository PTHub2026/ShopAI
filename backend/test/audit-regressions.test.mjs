import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM,VirtualConsole} from 'jsdom';

const source=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
function runtime(){
 const dom=new JSDOM(source,{url:'https://app.example/',runScripts:'dangerously',virtualConsole:new VirtualConsole(),beforeParse(w){w.scrollTo=()=>{};w.cancelAnimationFrame=()=>{};w.requestAnimationFrame=()=>1;}});
 const w=dom.window;
 return {w,run:code=>w.eval(code),query:selector=>w.document.querySelector(selector),close:()=>w.close()};
}
function change(r,input,value,event='change'){
 if(typeof value==='boolean')input.checked=value;else input.value=value;
 input.dispatchEvent(new r.w.Event(event,{bubbles:true}));
}
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));

test('composer customization toggle and both custom fields survive a draft reload',()=>{
 const r=runtime();try{
  r.run("D=newDraft();D.content='Shared draft';go('create');window.auditChannel=S.channels.find(c=>c.connected).id;togCustom(window.auditChannel)");
  assert.ok(r.run('loadDraft().custom[window.auditChannel]'),'opening customization saves its state');
  const fields=r.w.document.querySelectorAll('#chlist textarea');
  change(r,fields[0],'Separate channel text','input');
  assert.equal(r.run('loadDraft().custom[window.auditChannel].text'),'Separate channel text');
  change(r,fields[1],'First comment','input');
  assert.equal(r.run('loadDraft().custom[window.auditChannel].first'),'First comment');
  r.run('togCustom(window.auditChannel)');
  assert.equal(r.run('loadDraft().custom[window.auditChannel]'),undefined,'removing customization is saved too');
 }finally{r.close();}
});

for(const [type,value,property] of [['date','2028-12-03','date'],['time','19:35','time']]){
 test(`composer ${type} changes survive a draft reload`,()=>{
  const r=runtime();try{
   r.run("D=newDraft();D.when='later';go('create')");
   change(r,r.query(`input[type="${type}"]`),value);
   assert.equal(r.run(`loadDraft().${property}`),value);
  }finally{r.close();}
 });
}

test('composer create-another preference survives a draft reload',()=>{
 const r=runtime();try{
  r.run("D=newDraft();go('create')");
  const control=[...r.w.document.querySelectorAll('label')].find(label=>label.textContent.includes('Tạo bài viết khác')).querySelector('input');
  change(r,control,true);
  assert.equal(r.run('loadDraft().more'),true);
 }finally{r.close();}
});

test('AI channel adaptation preserves text edited while its request is pending',async()=>{
 const r=runtime();try{
  r.run("D=newDraft();D.content='Shared source';go('create');window.auditChannel=S.channels.find(c=>c.connected).id;togCustom(window.auditChannel)");
  const pending=deferred();r.w.auditAdapt=pending.promise;r.run('AI.call=()=>window.auditAdapt');
  const request=r.run('aiAdapt(window.auditChannel)');
  change(r,r.query('#chlist textarea'),'Manual text written during AI request','input');
  pending.resolve('Stale AI adaptation');await request;
  assert.equal(r.run('D.custom[window.auditChannel].text'),'Manual text written during AI request');
  assert.equal(r.query('#chlist textarea').value,'Manual text written during AI request');
 }finally{r.close();}
});

test('video media load completing after navigation preserves the current page',async()=>{
 const r=runtime();try{
  const pending=deferred();r.w.auditMedia=pending.promise;
  r.run("vDraw=()=>0;vMedia=()=>window.auditMedia;VP.scenes=[{id:'audit-scene',text:'Scene',d:3,asset:null}];go('video');vSetMedia(0,'audit-media');go('settings')");
  await settle();
  const currentView=r.query('#view').innerHTML;
  pending.resolve(null);await pending.promise;await settle();
  assert.equal(r.run('route'),'settings');
  assert.equal(r.query('#vcv'),null);
  assert.equal(r.query('#view').innerHTML,currentView,'loading media must not render video over settings');
 }finally{r.close();}
});

test('navigating during video export cancels recording and releases its tracks',async()=>{
 const r=runtime();try{
  let stoppedTracks=0,stoppedRecorders=0;
  r.w.MediaRecorder=class {
   static isTypeSupported(){return true;}
   state='inactive';
   start(){this.state='recording';}
   stop(){this.state='inactive';stoppedRecorders++;this.onstop?.();}
  };
  r.w.HTMLCanvasElement.prototype.captureStream=()=>({getTracks:()=>[{stop(){stoppedTracks++;}}]});
  r.w.requestAnimationFrame=()=>1;r.w.cancelAnimationFrame=()=>{};
  r.run("vDraw=()=>0;vPreload=async()=>{};VP.scenes=[{id:'export-scene',text:'Scene',d:3,asset:null}];go('video')");
  const originalAssets=r.run('S.assets.length');
  const exporting=r.run('vExport()');await settle();
  assert.ok(r.run('VS.rec'),'recording has started');
  r.run("go('settings');vFrame()");
  await Promise.race([exporting,new Promise((_,reject)=>setTimeout(()=>reject(Error('export did not settle after navigation')),100))]);
  assert.equal(stoppedRecorders,1);assert.equal(stoppedTracks,1);
  assert.equal(r.run('VS.rec'),null);assert.equal(r.run('VS.busy'),false);
  assert.equal(r.run('S.assets.length'),originalAssets,'cancelled export does not save a partial video');
  assert.equal(r.run('route'),'settings');assert.equal(r.query('#vcv'),null);
 }finally{r.close();}
});

test('video export does not start recording if navigation occurs during preload',async()=>{
 const r=runtime();try{
  const pending=deferred();r.w.auditPreload=pending.promise;let captures=0;
  r.w.MediaRecorder=class {static isTypeSupported(){return true;}};
  r.w.HTMLCanvasElement.prototype.captureStream=()=>{captures++;return {};};
  r.run("vDraw=()=>0;vPreload=()=>window.auditPreload;VP.scenes=[{text:'Scene',d:3}];go('video')");
  const exporting=r.run('vExport()');r.run("go('settings')");pending.resolve();await exporting;
  assert.equal(captures,0);assert.equal(r.run('VS.busy'),false);assert.equal(r.run('VS.rec'),null);
  assert.equal(r.query('#vcv'),null);
 }finally{r.close();}
});

test('seeking while exporting preserves recording playback and still permits cancellation',async()=>{
 const r=runtime();try{
  let stoppedTracks=0;
  r.w.MediaRecorder=class {static isTypeSupported(){return true;}state='inactive';start(){this.state='recording';}stop(){this.state='inactive';this.onstop?.();}};
  r.w.HTMLCanvasElement.prototype.captureStream=()=>({getTracks:()=>[{stop(){stoppedTracks++;}}]});
  r.run("vDraw=()=>0;vPreload=async()=>{};VP.scenes=[{text:'Scene',d:3}];go('video')");
  const exporting=r.run('vExport()');await settle();
  const time=r.run('VS.t');
  r.run('vSeek(2)');
  assert.equal(r.run('VS.playing'),true,'seek cannot pause the frame loop that completes export');
  assert.equal(r.run('VS.t'),time,'export time stays controlled by the frame loop');
  assert.equal(r.run('VS.rec.state'),'recording');
  r.run("go('settings');vFrame()");await exporting;
  assert.equal(stoppedTracks,1);assert.equal(r.run('VS.busy'),false);
 }finally{r.close();}
});

test('video recorder startup failure releases captured tracks and permits another export',async()=>{
 const r=runtime();try{
  let stoppedTracks=0;
  r.w.MediaRecorder=class {static isTypeSupported(){return true;}constructor(){throw Error('Recorder unavailable');}};
  r.w.HTMLCanvasElement.prototype.captureStream=()=>({getTracks:()=>[{stop(){stoppedTracks++;}}]});
  r.w.cancelAnimationFrame=()=>{};
  r.run("vDraw=()=>0;vPreload=async()=>{};VP.scenes=[{text:'Scene',d:3}];go('video')");
  await r.run('vExport()');
  assert.equal(stoppedTracks,1);assert.equal(r.run('VS.busy'),false);assert.equal(r.run('VS.rec'),null);
  await r.run('vExport()');assert.equal(stoppedTracks,2,'a failed recorder does not leave exporting locked');
 }finally{r.close();}
});

test('Video caption survives a redraw, deduplicates requests and preserves manual edits',async()=>{
 const r=runtime();
 try{
  r.run("vDraw=()=>0;VP=vNewProject();VP.topic='ShopTrack';go('video')");
  let calls=0,wait=deferred();
  r.w.readCaption=()=>{calls++;return wait.promise;};
  r.run("AI.call=()=>window.readCaption()");
  const first=r.run('vCaption()');
  r.run('V.video()');
  assert.equal(r.query('#v_capbtn').disabled,true);
  await r.run('vCaption()');
  assert.equal(calls,1);
  wait.resolve('Mô tả ShopTrack');
  await first;
  assert.match(r.query('#v_cap').value,/Mô tả ShopTrack/);
  assert.equal(r.query('#v_capbtn').disabled,false);
  wait=deferred();
  const second=r.run('vCaption()');
  change(r,r.query('#v_cap'),'Nội dung đã chỉnh tay','input');
  wait.resolve('Kết quả đến muộn');
  await second;
  assert.equal(r.query('#v_cap').value,'Nội dung đã chỉnh tay');
 }finally{r.close();}
});

test('Video scene count and duration display follow edits and clamping',async()=>{
 const r=runtime();
 try{
  r.run("vDraw=()=>0;VP=vNewProject();go('video');vAdd()");
  change(r,r.query('.vscene textarea'),'12345','input');
  assert.equal(r.query('#v_count_0').textContent,'5/120 ký tự');
  change(r,r.query('#v_duration_0'),'20');
  assert.equal(r.query('#v_duration_0').value,'15');
  assert.equal(r.query('#vtot').textContent,'15.0 s');
  assert.equal(r.query('#vseek').max,'15');
  await settle();
 }finally{r.close();}
});
