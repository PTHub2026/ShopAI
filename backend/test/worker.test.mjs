import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
const worker = (await import(new URL('../src/worker.js', import.meta.url))).default;
const { subtle } = webcrypto;
const pair = await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await subtle.exportKey('jwk', pair.publicKey), kid: 'test-key', use: 'sig', alg: 'RS256' };
const issuer = 'https://test-team.cloudflareaccess.com';
const origin = 'https://pthub2026.github.io';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
async function token(changes = {}, head = {}) {
  const data = encode({ alg: 'RS256', kid: 'test-key', ...head }) + '.' + encode({ iss: issuer, sub: 'user-a', aud: ['test-audience'], exp: Math.floor(Date.now() / 1000) + 3600, ...changes });
  return data + '.' + Buffer.from(await subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, Buffer.from(data))).toString('base64url');
}
const valid = await token();
function env(overrides = {}) {
  return { ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com', ACCESS_AUD: 'test-audience', ALLOWED_ORIGINS: origin, AI: { run: async () => ({ response: 'Nội dung thử nghiệm' }) }, AI_RATE_LIMITER: { limit: async () => ({ success: true }) }, ...overrides };
}
function request({ path = '/ai', method = 'POST', body = { task: 'improve', text: 'Nội dung gốc' }, jwt = valid, headers = {} } = {}) {
  return new Request('https://backend.example' + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', ...(jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {}), ...headers }, ...(method !== 'GET' && method !== 'OPTIONS' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
}
const realFetch = globalThis.fetch;
async function run(callback, certs = { keys: [jwk] }) {
  globalThis.fetch = async url => {
    assert.equal(String(url), issuer + '/cdn-cgi/access/certs');
    return new Response(JSON.stringify(certs), { headers: { 'Content-Type': 'application/json' } });
  };
  try { await callback(); } finally { globalThis.fetch = realFetch; }
}
test('Cấu hình thiếu trả 503; health không gọi AI', async () => {
  let called = false;
  const good = await worker.fetch(request({ path: '/health', method: 'GET' }), env({ AI: { run: () => { called = true; } } }));
  assert.equal(good.status, 200); assert.equal(called, false);
  assert.equal((await worker.fetch(request(), env({ ACCESS_AUD: '' }))).status, 503);
  assert.equal((await worker.fetch(request({ path: '/health', method: 'GET' }), env({ ACCESS_TEAM_DOMAIN: 'evil.example/path' }))).status, 503);
});
test('Đường dẫn, phương thức và CORS', async () => {
  assert.equal((await worker.fetch(request({ path: '/missing' }), env())).status, 404);
  const wrong = await worker.fetch(request({ method: 'GET' }), env());
  assert.equal(wrong.status, 405); assert.equal(wrong.headers.get('Allow'), 'POST, OPTIONS');
  assert.equal((await worker.fetch(request({ headers: { Origin: 'https://evil.example' } }), env())).status, 403);
  const preflight = await worker.fetch(request({ method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } }), env());
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'), 'true');
  assert.equal((await worker.fetch(request({ method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'DELETE' } }), env())).status, 403);
  assert.equal((await worker.fetch(request({ method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-evil' } }), env())).status, 403);
});
test('JWT thiếu, sai chữ ký, issuer, audience, thời hạn và nbf bị từ chối', async () => run(async () => {
  const forged = valid.split('.'); forged[2] = Buffer.alloc(256).toString('base64url');
  for (const jwt of [null, 'invalid', forged.join('.'), await token({ iss: 'https://evil.example' }), await token({ aud: ['wrong'] }), await token({ exp: 0 }), await token({ nbf: 'invalid' }), await token({ nbf: Math.floor(Date.now() / 1000) + 600 }), await token({}, { alg: 'HS256' }), await token({}, { kid: 'unknown' })]) {
    assert.equal((await worker.fetch(request({ jwt }), env())).status, 401);
  }
}));
test('Không có khóa xác minh thì từ chối', async () => run(async () => {
  assert.equal((await worker.fetch(request(), env())).status, 401);
}, { keys: [] }));
test('Bốn tác vụ thành công và prompt đúng tác vụ', async () => run(async () => {
  for (const task of ['generate', 'improve', 'adapt', 'reply']) {
    let captured;
    const response = await worker.fetch(request({ body: { task, text: 'Dữ kiện thực tế' } }), env({ AI: { run: async (model, payload) => { captured = payload; return { response: ' Kết quả thử nghiệm ' }; } } }));
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { text: 'Kết quả thử nghiệm' });
    assert.equal(JSON.parse(captured.messages[1].content).task, task); assert.equal(captured.max_completion_tokens, 1200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
}));
test('JSON, payload và Content-Type không hợp lệ', async () => run(async () => {
  for (const body of ['{', 'null', '[]', '{"task":"unknown","text":"x"}', '{"task":"improve"}', '{"task":"reply","text":"  "}']) {
    assert.equal((await worker.fetch(request({ body }), env())).status, 400);
  }
  assert.equal((await worker.fetch(request({ headers: { 'Content-Type': 'application/json-invalid' } }), env())).status, 415);
  assert.equal((await worker.fetch(request({ headers: { 'Content-Type': 'application/json; charset=utf-8' } }), env())).status, 200);
}));
test('Giới hạn thân UTF-8 đúng 32768 byte và vượt biên', async () => run(async () => {
  const prefix = '{"task":"improve","text":"'; const suffix = '"}';
  const body = prefix + 'a'.repeat(32768 - Buffer.byteLength(prefix + suffix)) + suffix;
  assert.equal(Buffer.byteLength(body), 32768);
  assert.equal((await worker.fetch(request({ body }), env())).status, 200);
  assert.equal((await worker.fetch(request({ body: body + ' ' }), env())).status, 413);
  assert.equal((await worker.fetch(request({ body: { task: 'improve', text: 'ệ'.repeat(12000) } }), env())).status, 413);
}));
test('Hạn mức, khóa băm và lỗi binding', async () => run(async () => {
  let key;
  const limited = await worker.fetch(request(), env({ AI_RATE_LIMITER: { limit: async value => { key = value.key; return { success: false }; } } }));
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('Retry-After'), '60'); assert.match(key, /^[a-f0-9]{64}$/); assert.equal(key.includes(valid), false);
  assert.equal((await worker.fetch(request(), env({ AI_RATE_LIMITER: { limit: async () => { throw new Error('private detail'); } } }))).status, 503);
}));
test('AI lỗi hoặc trả rỗng không rò thông tin nội bộ', async () => run(async () => {
  for (const run of [async () => { throw new Error('private detail'); }, async () => ({}), async () => ({ response: ' ' })]) {
    const response = await worker.fetch(request(), env({ AI: { run } }));
    assert.equal(response.status, 502); assert.equal((await response.text()).includes('private detail'), false);
  }
}));
test('Không gọi AI khi chỉ có tên thương hiệu nhưng thiếu nội dung', async () => run(async () => {
  let calls=0;
  for(const task of ['generate','improve','adapt','reply']) {
    const response=await worker.fetch(request({body:{task,brand:'ShopTrack',text:' ',name:'Khách'}}),env({AI:{run:async()=>{calls++;return {response:'Không được gọi'}}}}));
    assert.equal(response.status,400);
  }
  assert.equal(calls,0);
}));
test('Giao diện yêu cầu JWT, hỗ trợ HEAD, và chèn endpoint cùng origin',async()=>run(async()=>{
  let aiCalls=0,limitCalls=0;
  const e=env({FRONTEND_HTML:'<html><head></head><body>ShopAI</body></html>',AI:{run:async()=>{aiCalls++;return {response:'AI'}}},AI_RATE_LIMITER:{limit:async()=>{limitCalls++;return {success:true}}}});
  const make=(path,method='GET',jwt=valid)=>new Request('https://backend.example'+path,{method,headers:jwt?{'Cf-Access-Jwt-Assertion':jwt}:{}});
  const expired=await token({exp:0});
  for(const path of ['/','/index.html']){
    for(const jwt of [null,'invalid',expired])assert.equal((await worker.fetch(make(path,'GET',jwt),e)).status,401);
    const response=await worker.fetch(make(path),e);
    assert.equal(response.status,200);assert.match(await response.text(),/name="shopai-ai-endpoint" content="\/ai"/);
    const head=await worker.fetch(make(path,'HEAD'),e);
    assert.equal(head.status,200);assert.equal(await head.text(),'');
    assert.equal((await worker.fetch(make(path),env({...e,AI:null}))).status,503);
    assert.equal((await worker.fetch(make(path),env({...e,FRONTEND_HTML:undefined}))).status,503);
  }
  assert.equal(aiCalls,0);assert.equal(limitCalls,0);
  const sameOrigin=await worker.fetch(request({headers:{Origin:'https://backend.example'}}),env({...e,ALLOWED_ORIGINS:''}));
  assert.equal(sameOrigin.status,200);assert.equal(aiCalls,1);assert.equal(limitCalls,1);
}));


test('Session capabilities require a verified subject and separate local account scopes', async()=>run(async()=>{
  const first=await worker.fetch(request({path:'/session',method:'GET'}),env({DB:{}}));
  assert.equal(first.status,200);
  const session=await first.json();
  assert.match(session.userScope,/^[a-f0-9]{64}$/);
  assert.deepEqual(session.capabilities,{ai:true,drafts:true,publishing:false,scheduling:false,inbox:false});
  const second=await (await worker.fetch(request({path:'/session',method:'GET',jwt:await token({sub:'user-b'})}),env())).json();
  assert.notEqual(second.userScope,session.userScope);assert.equal(second.capabilities.drafts,false);
  const page=await worker.fetch(request({path:'/',method:'GET'}),env({FRONTEND_HTML:'<head></head><body></body>'}));
  assert.ok((await page.text()).includes('name="shopai-user-scope" content="'+session.userScope+'"'));
  for(const sub of ['',undefined,42]){
    assert.equal((await worker.fetch(request({path:'/session',method:'GET',jwt:await token({sub})}),env())).status,403);
    assert.equal((await worker.fetch(request({path:'/',method:'GET',jwt:await token({sub})}),env({FRONTEND_HTML:'<head></head>'}))).status,403);
  }
  assert.equal((await worker.fetch(request({path:'/session',method:'GET',jwt:null}),env())).status,401);
}));

test('Storage refuses an editor belonging to a different Access account',async()=>run(async()=>{
  const response=await worker.fetch(request({path:'/storage/drafts',method:'GET',headers:{'X-ShopAI-User-Scope':'b'.repeat(64)}}),env({DB:{}}));
  assert.equal(response.status,403);assert.equal((await response.json()).code,'ACCOUNT_CHANGED');
  assert.equal((await worker.fetch(request({path:'/storage/drafts',method:'GET',jwt:null}),env({DB:{}}))).status,401);
}));
test('Renewing a JWT does not reset the user AI rate-limit key',async()=>run(async()=>{
  const keys=[];const e=env({AI_RATE_LIMITER:{limit:async({key})=>{keys.push(key);return {success:true}}}});
  await worker.fetch(request(),e);
  await worker.fetch(request({jwt:await token({exp:Math.floor(Date.now()/1000)+7200})}),e);
  assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);
}));
test('Current Workers AI chat-completion output is normalized without leaking reasoning', async () => run(async () => {
  let used;
  const response=await worker.fetch(request(),env({AI:{run:async(model,payload)=>{used={model,payload};return {choices:[{message:{content:' Nội dung mới ',reasoning_content:'private reasoning'},finish_reason:'stop'}]};}}}));
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{text:'Nội dung mới'});
  assert.equal(used.model,'@cf/google/gemma-4-26b-a4b-it');
  assert.equal(used.payload.max_completion_tokens,1200);
  assert.deepEqual(used.payload.chat_template_kwargs,{enable_thinking:false});
}));
test('Reasoning-only, tool-only and truncated outputs never become successful copy', async () => run(async () => {
  for(const result of [{choices:[{message:{content:null,reasoning_content:'hidden'},finish_reason:'stop'}]},{choices:[{message:{content:'partial'},finish_reason:'length'}]}]){
    assert.equal((await worker.fetch(request(),env({AI:{run:async()=>result}}))).status,502);
  }
}));

test('Facebook endpoints require verified Access and account scope before OAuth',async()=>run(async()=>{
  assert.equal((await worker.fetch(request({path:'/channels/facebook',method:'GET',jwt:null}),env())).status,401);
  assert.equal((await worker.fetch(request({path:'/channels/facebook',method:'GET',headers:{'X-ShopAI-User-Scope':'wrong'}}),env())).status,403);
  assert.equal((await worker.fetch(request({path:'/channels/facebook/start',headers:{Origin:'https://backend.example'}}),env())).status,403);
  const response=await worker.fetch(request({path:'/channels/facebook',method:'GET'}),env());
  assert.equal(response.status,200);assert.equal((await response.json()).configured,false);
}));
