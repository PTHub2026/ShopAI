import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const worker = (await import(new URL('../src/worker.js', import.meta.url))).default;
const page = name => readFile(new URL('../../' + name, import.meta.url), 'utf8');
const get = (path, method = 'GET') => worker.fetch(new Request('https://shoppost.net' + path, { method }), {});

test('Worker tự phục vụ favicon, apple-touch-icon và ảnh og:image không cần đăng nhập', async () => {
  const ico = await get('/favicon.ico');
  assert.equal(ico.status, 200);
  assert.equal(ico.headers.get('Content-Type'), 'image/x-icon');
  const bytes = new Uint8Array(await ico.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 4)], [0, 0, 1, 0], 'chữ ký tệp ICO');
  for (const path of ['/apple-touch-icon.png', '/og-image.png']) {
    const r = await get(path);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('Content-Type'), 'image/png');
    assert.deepEqual([...new Uint8Array(await r.arrayBuffer()).slice(1, 4)], [80, 78, 71], 'chữ ký PNG');
  }
  const head = await get('/favicon.ico', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await get('/favicon.ico', 'POST')).status, 405);
});

test('index.html và login.html có meta description, Open Graph và favicon', async () => {
  for (const name of ['index.html', 'login.html']) {
    const html = await page(name);
    assert.match(html, /<meta name="description" content="ShopPost — Quản lý &amp; đăng bài lên nhiều kênh mạng xã hội từ một nơi duy nhất.">/, name);
    for (const prop of ['og:title', 'og:description', 'og:image', 'og:url', 'og:type']) assert.match(html, new RegExp(`<meta property="${prop}" content="[^"]+">`), `${name} thiếu ${prop}`);
    assert.match(html, /<meta property="og:image" content="https:\/\/shoppost\.net\/og-image\.png">/, name);
    assert.match(html, /<link rel="icon" href="\/favicon\.ico"/, name);
  }
});

test('login.html: form có mật khẩu dùng POST, mật khẩu có minlength=8, không còn giới hạn tên miền', async () => {
  const html = await page('login.html');
  const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(m => m[0]);
  const withPassword = forms.filter(f => /type="password"/.test(f));
  assert.equal(withPassword.length, 3);
  for (const form of withPassword) assert.match(form, /^<form\b[^>]*\bmethod="POST"/);
  const passwords = [...html.matchAll(/<input\b[^>]*type="password"[^>]*>/g)].map(m => m[0]);
  assert.equal(passwords.length, 4);
  for (const input of passwords) assert.match(input, /\bminlength="8"/);
  assert.doesNotMatch(html, /@pthub\.vn|@shoptrack\.vn|ban@pthub/);
  assert.match(html, /\.pw-toggle\{[^}]*min-height:44px;min-width:44px/);
  assert.match(html, /\.btn\.link\{[^}]*min-height:44px/);
});
