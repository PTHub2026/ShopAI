import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {encryptToken,decryptToken,SOCIAL_SCHEMA,handleSocial} from '../src/social.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const key=()=>Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64');
test('token encrypted at rest, unique IV, decryptable with configured key',async()=>{
 const env={SOCIAL_TOKEN_KEY:key()},token='123456789:TEST_SECRET_TOKEN_NEVER_STORE_PLAINTEXT';
 const a=await encryptToken(env,token),b=await encryptToken(env,token);
 assert.notEqual(a.cipher,token);assert.notEqual(a.cipher,b.cipher);assert.notEqual(a.iv,b.iv);
 assert.equal(await decryptToken(env,a.cipher,a.iv),token);
 await assert.rejects(decryptToken({SOCIAL_TOKEN_KEY:key()},a.cipher,a.iv));
});
test('missing encryption key fails closed',async()=>{
 await assert.rejects(encryptToken({},'test'));
 const response=await handleSocial(new Request('https://example.com/api/social/accounts'),{DB:{}},{owner:'user'},(v,s=200)=>new Response(JSON.stringify(v),{status:s}));
 assert.equal(response.status,503);
 assert.equal((await response.json()).code,'social_key_missing');
});
test('schema enforces per-shop idempotency and scoped accounts',()=>{
 const s=SOCIAL_SCHEMA.join('\n');
 assert.match(s,/UNIQUE\(shop_id,idempotency_key\)/);
 assert.match(s,/UNIQUE\(shop_id,provider,target_id\)/);
 assert.match(s,/CHECK\(status IN \('pending','sending','sent','retryable','unknown','failed'\)\)/);
 const migration=readFileSync(new URL('../migrations/0008_social_publishing.sql',import.meta.url),'utf8');
 assert.match(migration,/UNIQUE\(shop_id,idempotency_key\)/);
 assert.match(migration,/UNIQUE\(shop_id,provider,target_id\)/);
});
test('publisher safeguards: shop scoping, conditional claim and unknown no replay',()=>{
 const source=readFileSync(new URL('../src/social.js',import.meta.url),'utf8');
 assert.match(source,/resolveShop\(env,who,req\)/);
 assert.match(source,/WHERE shop_id=\? AND id=\?/);
 assert.match(source,/status IN \('pending','retryable'\)/);
 assert.match(source,/delivery_uncertain/);
 assert.match(source,/status='revoked',token='',token_iv=''/);
 assert.doesNotMatch(source,/console\.log\([^)]*token/);
});
test('jobView includes provider from channel in publish and retry/run responses',()=>{
 // Regression: publish_jobs has no provider column; before fix, jobView(j) returned provider:undefined
 // in responses from POST /jobs (publish) and POST /jobs/:id/retry. The fix spreads provider from
 // the already-fetched channel account into j before calling deliver() / jobView().
 const source=readFileSync(new URL('../src/social.js',import.meta.url),'utf8');
 // publish path: provider from 'a' (the channel) must be spread into j before deliver/jobView
 assert.match(source,/jobView\(\{\.\.\.j,provider:a\.provider\}\)/);
 // retry/run path: provider from 'account' must be spread into j before deliver
 assert.match(source,/deliver\(\{\.\.\.j,provider:account\?\.provider\?\?null\}/);
});
