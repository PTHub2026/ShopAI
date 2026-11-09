import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
await import('../build.mjs');
const dataURL = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const dist = async name => readFile(new URL('../dist/' + name, import.meta.url), 'utf8');
// Nối các mô-đun đã build theo thứ tự phụ thuộc: permissions → auth → shops → drafts → worker.
const permissionsURL = dataURL(await dist('permissions.js'));
const authURL = dataURL(await dist('auth.js'));
const shopsURL = dataURL((await dist('shops.js')).replace("'./auth.js'", JSON.stringify(authURL)).replace("'./permissions.js'", JSON.stringify(permissionsURL)));
const draftsURL = dataURL((await dist('drafts.js')).replace("'./shops.js'", JSON.stringify(shopsURL)));
const workerSource = (await dist('worker.js')).replace("'./drafts.js'", JSON.stringify(draftsURL)).replace("'./auth.js'", JSON.stringify(authURL)).replace("'./shops.js'", JSON.stringify(shopsURL)).replace("'./permissions.js'", JSON.stringify(permissionsURL));
const workerURL = dataURL(workerSource);
const appSource = (await readFile(new URL('../dist/app.js', import.meta.url), 'utf8')).replace("'./worker.js'", JSON.stringify(workerURL));
const app = (await import('data:text/javascript;base64,' + Buffer.from(appSource).toString('base64'))).default;

test('Build includes the repository frontend and serves it behind Access', async () => {
  const builtApp = await readFile(new URL('../dist/app.js', import.meta.url), 'utf8');
  assert.ok(builtApp.includes('Shoppost'));
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Không cho phép tải ngoài trong kiểm thử này'); };
  try {
    const env = {
      AI: {},
      AI_RATE_LIMITER: {},
      ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
      ACCESS_AUD: 'test-audience'
    };
    const health = await app.fetch(new Request('https://shopai-backend.example/health'), env);
    assert.equal(health.status, 200);
    // Chưa có Access JWT hay phiên đăng nhập: trả trang đăng nhập đã đóng gói, không phải giao diện ứng dụng.
    const page = await app.fetch(new Request('https://shopai-backend.example/'), env);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('Content-Type'), /text\/html/);
    const loginHtml = await page.text();
    assert.match(loginHtml, /Đăng nhập Shoppost/);
    assert.equal(loginHtml.includes('shopai-user-scope'), false);
    assert.equal(loginHtml.includes('__CSP_NONCE__'), false);
    const nonce = /nonce="([A-Za-z0-9_-]+)"/.exec(loginHtml)[1];
    assert.ok(page.headers.get('Content-Security-Policy').includes("'nonce-" + nonce + "'"));
  } finally { globalThis.fetch = original; }
});


test('Built health exposes the packaged commit for deployment verification', async()=>{
  const response=await app.fetch(new Request('https://shopai-backend.example/health'),{});
  const body=await response.json();
  assert.match(body.release,/^[a-f0-9]{40}$/);
});
