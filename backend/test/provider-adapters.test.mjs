import test from 'node:test';
import assert from 'node:assert/strict';
test('provider adapters enforce cover, Instagram photo and Telegram text limits',async()=>{
 const {validatePost}=await import('../src/provider-adapters.js');
 assert.throws(()=>validatePost('zalo',{kind:'photo',text:'Hello',images:[]}),/ảnh bìa/);
 assert.throws(()=>validatePost('instagram',{kind:'text',text:'Hello'}),/instagram_requires_photo/);
 assert.throws(()=>validatePost('telegram',{kind:'text',text:'x'.repeat(4097)}),/invalid_input/);
 assert.doesNotThrow(()=>validatePost('telegram',{kind:'text',text:'Hello'}));
});
test('backoff honors provider wait, caps attempts and never retries ambiguous sends',async()=>{
 const {retryDecision}=await import('../src/provider-adapters.js');
 const rate={status:429,retryAfter:120};
 assert.equal(retryDecision(rate,1).status,'retryable');assert.ok(retryDecision(rate,1).delay>=120);
 assert.ok(retryDecision({safeToRetry:true,status:503},3).delay>retryDecision({safeToRetry:true,status:503},1).delay);
 assert.equal(retryDecision(rate,5).status,'failed');
 assert.equal(retryDecision({status:502},1).status,'unknown');
 assert.equal(retryDecision({status:401},1).reauth,true);
});
