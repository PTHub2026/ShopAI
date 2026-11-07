import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
await import('../build.mjs');
const workerSource = await readFile(new URL('../dist/worker.js', import.meta.url), 'utf8');
const workerURL = 'data:text/javascript;base64,' + Buffer.from(workerSource).toString('base64');
const appSource = (await readFile(new URL('../dist/app.js', import.meta.url), 'utf8')).replace("'./worker.js'", JSON.stringify(workerURL));
const app = (await import('data:text/javascript;base64,' + Buffer.from(appSource).toString('base64'))).default;
test('Bản đóng gói trả giao diện không dùng mạng bên ngoài', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Không cho phép tải ngoài trong kiểm thử này'); };
  try {
    const response = await app.fetch(new Request('https://shopai-backend.ct-3f8.workers.dev/'), {});
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes("fetch('/ai',{method:'POST',credentials:'same-origin'"));
    assert.ok(!html.includes('return AI.local[task](p)'));
    assert.ok(html.includes('các kênh vẫn mô phỏng'));
  } finally { globalThis.fetch = original; }
});
