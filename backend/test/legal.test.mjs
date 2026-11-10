import { test } from 'node:test';
import assert from 'node:assert/strict';
const worker = (await import(new URL('../src/worker.js', import.meta.url))).default;

test('Trang pháp lý công khai cho Meta App Review không cần đăng nhập', async () => {
  for (const [path, text] of [['/privacy', 'Chính sách quyền riêng tư'], ['/terms', 'Điều khoản sử dụng'], ['/data-deletion', 'Hướng dẫn xóa dữ liệu người dùng']]) {
    const res = await worker.fetch(new Request('https://shoppost.net' + path), {});
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('Content-Type'), /text\/html/);
    assert.match(res.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
    const body = await res.text();
    assert.ok(body.includes(text), path);
    assert.ok(!/<script/i.test(body), path);
  }
  const head = await worker.fetch(new Request('https://shoppost.net/privacy', { method: 'HEAD' }), {});
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const post = await worker.fetch(new Request('https://shoppost.net/terms', { method: 'POST' }), {});
  assert.equal(post.status, 405);
});

test('Drive privacy and deletion instructions distinguish the separate grant from YouTube',async()=>{
 const p=await (await worker.fetch(new Request('https://shoppost.net/privacy'),{})).text();
 assert.match(p,/Google Drive trong Kho tài nguyên/);assert.match(p,/xem và tải tất cả tệp/);assert.match(p,/thành viên.*quyền nhập/s);assert.match(p,/không tự đồng bộ/);
 const d=await (await worker.fetch(new Request('https://shoppost.net/data-deletion'),{})).text();assert.match(d,/Ngắt Drive/);
});
