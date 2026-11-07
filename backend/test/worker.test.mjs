import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
const worker = (await import('data:text/javascript;base64,' + Buffer.from(await readFile(new URL('../src/worker.js', import.meta.url))).toString('base64'))).default;
const { subtle } = webcrypto;
const pair = await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await subtle.exportKey('jwk', pair.publicKey), kid: 'test-key', use: 'sig', alg: 'RS256' };
const issuer = 'https://test-team.cloudflareaccess.com';
const origin = 'https://pthub2026.github.io';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
async function token(changes = {}, head = {}) {
  const data = encode({ alg: 'RS256', kid: 'test-key', ...head }) + '.' + encode({ iss: issuer, aud: ['test-audience'], exp: Math.floor(Date.now() / 1000) + 3600, ...changes });
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
    assert.equal(JSON.parse(captured.messages[1].content).task, task); assert.equal(captured.max_tokens, 1200);
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
  const e=env({FRONTEND_HTML:'<html><head></head><body>ShopAI</body></html>'});
  const make=(method='GET',jwt=valid)=>new Request('https://backend.example/',{method,headers:jwt?{'Cf-Access-Jwt-Assertion':jwt}:{}});
  assert.equal((await worker.fetch(make('GET',null),e)).status,401);
  const response=await worker.fetch(make(),e);
  assert.equal(response.status,200);assert.match(await response.text(),/name="shopai-ai-endpoint" content="\/ai"/);
  assert.equal(await (await worker.fetch(make('HEAD'),e)).text(),'');
  assert.equal((await worker.fetch(request({headers:{Origin:'https://backend.example'}}),e)).status,200);
}));
