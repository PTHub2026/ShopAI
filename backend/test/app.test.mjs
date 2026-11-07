import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const workerSource = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');
const workerURL = 'data:text/javascript;base64,' + Buffer.from(workerSource).toString('base64');
const appSource = (await readFile(new URL('../src/app.js', import.meta.url), 'utf8')).replace("'./worker.js'", JSON.stringify(workerURL));
const app = (await import('data:text/javascript;base64,' + Buffer.from(appSource).toString('base64'))).default;
const sourceURL = 'https://raw.githubusercontent.com/PTHub2026/ShopAI/bc680c3e3621b71bb02768b2f623ce8276db6124/index.html';
const htmlFixture = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
test('Giao diện nguồn khớp hợp đồng và được nối API cùng origin, không fallback', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async url => { assert.equal(url, sourceURL); return new Response(htmlFixture); };
    const response = await app.fetch(new Request('https://shopai-backend.example/'), {});
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes("fetch('/ai',{method:'POST',credentials:'same-origin'"));
    assert.ok(!html.includes("return AI.local[task](p)"));
    assert.ok(html.includes('Không dùng nội dung mô phỏng.'));
    assert.ok(html.includes('Không gọi AI thật trong chế độ QA'));
    assert.ok(html.includes('Không thể tạo nội dung. Vui lòng thử lại.'));
    assert.ok(html.includes("button.textContent='✨ Viết caption'"));
    assert.ok(html.includes('các kênh vẫn mô phỏng'));
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  } finally { globalThis.fetch = original; }
});
test('Thiếu nguồn hoặc thay đổi hợp đồng không phục vụ bản demo', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async url => { assert.equal(url, sourceURL); return new Response('<html>Khác hợp đồng</html>'); };
    assert.equal((await app.fetch(new Request('https://app.example/'), {})).status, 503);
    globalThis.fetch = async () => new Response('', { status: 503 });
    assert.equal((await app.fetch(new Request('https://app.example/'), {})).status, 503);
  } finally { globalThis.fetch = original; }
});
test('Đường dẫn lạ và phương thức sai bị từ chối', async () => {
  assert.equal((await app.fetch(new Request('https://app.example/missing'), {})).status, 404);
  assert.equal((await app.fetch(new Request('https://app.example/', { method: 'POST' }), {})).status, 405);
});
