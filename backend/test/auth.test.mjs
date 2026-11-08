import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
const worker = (await import(new URL('../src/worker.js', import.meta.url))).default;
const { AUTH_SCHEMA, SESSION_COOKIE, normalizeEmail, normalizePhone, pkceChallenge, pkceVerifier, sameText, tiktokChallenge } = await import(new URL('../src/auth.js', import.meta.url));

const BASE = 'https://shoppost.example';
const FB_ID = '123456789012', ZALO_ID = '1234567890123456789', ZALO_SECRET = 'zalo-secret-khong-duoc-lo', RESEND_KEY = 're_khoa_bi_mat_thu_nghiem';
const issuer = 'https://test-team.cloudflareaccess.com';
const sha = text => createHash('sha256').update(text).digest('hex');
const now = () => Math.floor(Date.now() / 1000);

// SQL và schema thật (node:sqlite); chỉ mô phỏng phong bì kết quả bất đồng bộ của D1, kể cả batch.
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_drafts.sql', import.meta.url), 'utf8'));
  const statement = (sql, params) => ({
    bind: (...next) => statement(sql, next),
    async all() { return { results: sqlite.prepare(sql).all(...params) }; },
    async first() { return sqlite.prepare(sql).get(...params) || null; },
    async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...params).changes) } }; },
    exec: () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...params).changes) } })
  });
  return { sqlite, prepare: sql => statement(sql, []), async batch(list) {
    sqlite.exec('BEGIN');
    try { const out = list.map(s => s.exec()); sqlite.exec('COMMIT'); return out; } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
}
const row = (db, sql, ...params) => db.sqlite.prepare(sql).get(...params) || null;
const rows = (db, sql, ...params) => db.sqlite.prepare(sql).all(...params);

const LOGIN_HTML = '<!DOCTYPE html><html lang="vi"><head><script nonce="__CSP_NONCE__">window.dangNhap=1</script></head><body><h1>Đăng nhập ShopPost</h1></body></html>';
function env(overrides = {}) {
  return {
    ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com', ACCESS_AUD: 'test-audience', ALLOWED_ORIGINS: 'https://pthub2026.github.io',
    AI: { run: async () => ({ response: 'Nội dung AI' }) }, AI_RATE_LIMITER: { limit: async () => ({ success: true }) }, DB: database(),
    FACEBOOK_APP_ID: FB_ID, ZALO_APP_ID: ZALO_ID, ZALO_APP_SECRET: ZALO_SECRET, RESEND_API_KEY: RESEND_KEY, EMAIL_FROM: 'ShopPost <no-reply@shoppost.net>',
    FRONTEND_HTML: '<html><head></head><body>Ứng dụng ShopPost</body></html>', LOGIN_HTML, ...overrides
  };
}
const get = (e, path, headers = {}, method = 'GET') => worker.fetch(new Request(BASE + path, { method, headers }), e);
const post = (e, path, body = {}, headers = {}) => worker.fetch(new Request(BASE + path, { method: 'POST', headers: { Origin: BASE, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }), e);
const cookieNamed = (response, name) => response.headers.getSetCookie().find(c => c.startsWith(name + '=')) || null;
const sessionToken = response => cookieNamed(response, SESSION_COOKIE).split(';')[0].slice(SESSION_COOKIE.length + 1);
const withSession = token => ({ Cookie: `${SESSION_COOKIE}=${token}` });

// Access JWT thật (RS256) để chứng minh luồng cũ vẫn hoạt động song song.
const { subtle } = webcrypto;
const pair = await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await subtle.exportKey('jwk', pair.publicKey), kid: 'test-key', use: 'sig', alg: 'RS256' };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const head = encode({ alg: 'RS256', kid: 'test-key' }) + '.' + encode({ iss: issuer, sub: 'user-a', aud: ['test-audience'], exp: now() + 3600 });
const JWT = head + '.' + Buffer.from(await subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, Buffer.from(head))).toString('base64url');

// Mọi gọi mạng đều đi qua bộ giả lập; gọi ngoài dự kiến sẽ ném lỗi và được ghi lại.
const realFetch = globalThis.fetch;
async function withFetch(handler, callback) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    if (url === issuer + '/cdn-cgi/access/certs') return Response.json({ keys: [jwk] });
    if (!handler) throw new Error('Gọi mạng ngoài dự kiến: ' + url);
    return handler(url, init);
  };
  try { return await callback(calls); } finally { globalThis.fetch = realFetch; }
}
const facebook = (appId = FB_ID, me = { id: '10001', name: 'Nguyễn <b>Văn</b> A' }) => async url => {
  if (url.startsWith('https://graph.facebook.com/v21.0/app?access_token=')) return Response.json({ id: appId, name: 'ShopPost' });
  if (url.startsWith('https://graph.facebook.com/v21.0/me?fields=id,name&access_token=')) return Response.json(me);
  throw new Error('URL Facebook lạ: ' + url);
};
const FB_TOKEN = 'EAAB' + 'x'.repeat(60);

test('Hàm tiện ích: PKCE theo RFC 7636, so sánh hằng thời gian, chuẩn hóa email', async () => {
  assert.equal(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const verifier = pkceVerifier();
  assert.match(verifier, /^[A-Za-z0-9]{43}$/); assert.notEqual(verifier, pkceVerifier());
  assert.equal(sameText('abc', 'abc'), true); assert.equal(sameText('abc', 'abd'), false); assert.equal(sameText('abc', 'abcd'), false); assert.equal(sameText(null, 'a'), false);
  assert.equal(normalizeEmail('  Khach@Example.COM '), 'khach@example.com');
  for (const bad of ['', 'khong-co-a-cong', 'a@b', 'a b@c.vn', 'x'.repeat(250) + '@a.vn', 'a@b.vn\r\nBcc: c@d.vn', null]) assert.equal(normalizeEmail(bad), null);
});

test('Migration 0002_auth.sql khớp đúng schema runtime', () => {
  const norm = sql => sql.replace(/\s+/g, ' ').trim();
  const file = readFileSync(new URL('../migrations/0002_auth.sql', import.meta.url), 'utf8').split('\n').filter(line => !line.startsWith('--')).join('\n');
  assert.deepEqual(file.split(';').map(norm).filter(Boolean), AUTH_SCHEMA.map(norm));
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0002_auth.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0002_auth.sql', import.meta.url), 'utf8')); // chạy lại an toàn
  db.close();
});

test('/auth/providers phản ánh đúng cấu hình và không lộ secret', async () => {
  const off = await (await get(env({ FACEBOOK_APP_ID: undefined, ZALO_APP_SECRET: undefined, RESEND_API_KEY: undefined, EMAIL_FROM: undefined }), '/auth/providers')).json();
  assert.deepEqual(off, { facebook: { enabled: false }, zalo: { enabled: false }, tiktok: { enabled: false }, phone: { enabled: false }, email: { enabled: false }, access: { url: issuer }, ready: false });
  const response = await get(env(), '/auth/providers');
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { facebook: { enabled: true, appId: FB_ID }, zalo: { enabled: true }, tiktok: { enabled: false }, phone: { enabled: false }, email: { enabled: true }, access: { url: issuer }, ready: true });
  for (const secret of [ZALO_SECRET, RESEND_KEY]) assert.equal(text.includes(secret), false);
  // App ID không phải dãy số (ví dụ dán nhầm App Secret 32 ký tự hex) thì không bật Facebook.
  assert.equal((await (await get(env({ FACEBOOK_APP_ID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' }), '/auth/providers')).json()).facebook.enabled, false);
  assert.equal((await (await get(env({ ZALO_APP_SECRET: ' ' }), '/auth/providers')).json()).zalo.enabled, false);
  assert.equal((await (await get(env({ EMAIL_FROM: 'sai\r\nBcc: x@y.vn' }), '/auth/providers')).json()).email.enabled, false);
  const noDb = await (await get(env({ DB: undefined }), '/auth/providers')).json();
  assert.equal(noDb.ready, false); assert.equal(noDb.facebook.enabled || noDb.zalo.enabled || noDb.email.enabled, false);
  assert.equal((await post(env(), '/auth/providers')).status, 405);
  assert.equal((await get(env(), '/auth/khong-co')).status, 404);
});

test('Chưa đăng nhập: / trả trang đăng nhập với CSP nonce riêng, không lộ giao diện ứng dụng', async () => {
  const e = env();
  for (const headers of [{}, withSession('a'.repeat(43)), withSession('ngan'), { Cookie: 'khac=1' }]) {
    const response = await get(e, '/', headers);
    assert.equal(response.status, 200);
    const html = await response.text(), csp = response.headers.get('Content-Security-Policy');
    assert.match(html, /Đăng nhập ShopPost/); assert.doesNotMatch(html, /shopai-user-scope|Ứng dụng ShopPost|__CSP_NONCE__/);
    const nonce = html.match(/nonce="([A-Za-z0-9_-]{22})"/)[1];
    assert.ok(csp.includes(`'nonce-${nonce}'`)); assert.ok(csp.includes('https://connect.facebook.net')); assert.ok(csp.includes("frame-ancestors 'none'"));
    assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  }
  const head = await get(e, '/index.html', {}, 'HEAD');
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal((await get(e, '/session')).status, 401);
  assert.equal((await get(e, '/storage/drafts')).status, 401);
  assert.equal((await post(e, '/ai', { task: 'improve', text: 'x' })).status, 401);
});

test('Access JWT vẫn hoạt động như cũ (owner = sub) và được ưu tiên hơn phiên', async () => withFetch(facebook(), async () => {
  const e = env();
  const app = await get(e, '/', { 'Cf-Access-Jwt-Assertion': JWT });
  assert.equal(app.status, 200);
  assert.match(await app.text(), new RegExp(`name="shopai-user-scope" content="${sha('user-a')}"`));
  const session = await (await get(e, '/session', { 'Cf-Access-Jwt-Assertion': JWT })).json();
  assert.equal(session.userScope, sha('user-a')); assert.equal(session.auth, 'access'); assert.equal(session.account, null);
  const login = await post(e, '/auth/facebook', { accessToken: FB_TOKEN });
  const both = await (await get(e, '/session', { 'Cf-Access-Jwt-Assertion': JWT, ...withSession(sessionToken(login)) })).json();
  assert.equal(both.userScope, sha('user-a'));
  const logout = await post(e, '/auth/logout', {}, { 'Cf-Access-Jwt-Assertion': JWT });
  assert.deepEqual(await logout.json(), { ok: true, next: '/cdn-cgi/access/logout' });
}));

test('Facebook: đúng app id tạo phiên an toàn; phiên dùng được cho giao diện, /session và bản nháp', async () => withFetch(facebook(), async calls => {
  const e = env();
  const response = await post(e, '/auth/facebook', { accessToken: FB_TOKEN });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true); assert.equal(body.provider, 'facebook'); assert.equal(body.name, 'Nguyễn bVăn/b A');
  const cookie = cookieNamed(response, SESSION_COOKIE);
  for (const part of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=2592000']) assert.ok(cookie.includes(part), part);
  const token = sessionToken(response);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const saved = row(e.DB, 'SELECT * FROM auth_sessions');
  assert.equal(saved.token_hash, sha(token)); assert.equal(saved.owner, 'fb:10001'); assert.equal(saved.provider, 'facebook');
  assert.ok(Math.abs(saved.expires_at - (now() + 2592000)) < 5);
  assert.equal(JSON.stringify(rows(e.DB, 'SELECT * FROM auth_sessions')).includes(token), false);
  assert.equal(row(e.DB, 'SELECT owner FROM auth_identities').owner, 'fb:10001');
  assert.equal(calls.length, 2); assert.ok(calls[0].url.endsWith(encodeURIComponent(FB_TOKEN)));
  const session = await (await get(e, '/session', withSession(token))).json();
  assert.equal(session.auth, 'session'); assert.equal(session.userScope, sha('fb:10001'));
  assert.deepEqual(session.account, { provider: 'facebook', name: 'Nguyễn bVăn/b A' });
  const app = await get(e, '/', withSession(token));
  assert.match(await app.text(), new RegExp(`content="${sha('fb:10001')}"`));
  const draftsList = await get(e, '/storage/drafts', withSession(token));
  assert.equal(draftsList.status, 200); assert.deepEqual((await draftsList.json()).drafts, []);
}));

test('Facebook: sai app id, lỗi Graph, token sai định dạng, thiếu cấu hình hoặc lỗi mạng đều bị từ chối', async () => {
  for (const handler of [facebook('999999999'), async () => Response.json({ error: { message: 'Invalid OAuth access token' } }, { status: 400 })]) {
    await withFetch(handler, async () => {
      const e = env();
      const response = await post(e, '/auth/facebook', { accessToken: FB_TOKEN });
      assert.equal(response.status, 401); assert.equal(cookieNamed(response, SESSION_COOKIE), null);
      assert.equal(rows(e.DB, "SELECT name FROM sqlite_master WHERE name = 'auth_sessions'").length ? rows(e.DB, 'SELECT * FROM auth_sessions').length : 0, 0);
    });
  }
  await withFetch(facebook(FB_ID, { id: 'khong-phai-so', name: 'X' }), async () => assert.equal((await post(env(), '/auth/facebook', { accessToken: FB_TOKEN })).status, 401));
  await withFetch(async () => { throw new Error('mạng lỗi chi tiết nội bộ'); }, async () => {
    const response = await post(env(), '/auth/facebook', { accessToken: FB_TOKEN });
    assert.equal(response.status, 502); assert.equal((await response.text()).includes('chi tiết nội bộ'), false);
  });
  await withFetch(null, async calls => {
    for (const accessToken of [undefined, 'ngan', 'x'.repeat(5000), 'token có khoảng trắng và dấu'.padEnd(30, 'x'), { a: 1 }]) assert.equal((await post(env(), '/auth/facebook', { accessToken })).status, 400);
    assert.equal((await post(env(), '/auth/facebook', '{"accessToken":', {})).status, 400);
    assert.equal((await post(env(), '/auth/facebook', { accessToken: FB_TOKEN }, { 'Content-Type': 'text/plain' })).status, 400);
    assert.equal((await post(env({ FACEBOOK_APP_ID: undefined }), '/auth/facebook', { accessToken: FB_TOKEN })).status, 503);
    assert.equal(calls.length, 0);
  });
});

test('Chống CSRF và giới hạn tần suất cho POST đăng nhập', async () => withFetch(null, async calls => {
  const e = env();
  const noOrigin = await worker.fetch(new Request(BASE + '/auth/facebook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: FB_TOKEN }) }), e);
  assert.equal(noOrigin.status, 403);
  assert.equal((await post(e, '/auth/facebook', { accessToken: FB_TOKEN }, { Origin: 'https://evil.example' })).status, 403);
  // Origin nằm trong danh sách CORS vẫn không được đăng nhập/đăng xuất thay người dùng.
  assert.equal((await post(e, '/auth/email/start', { email: 'a@b.vn' }, { Origin: 'https://pthub2026.github.io' })).status, 403);
  assert.equal((await post(e, '/auth/logout', {}, { Origin: 'https://pthub2026.github.io' })).status, 403);
  let key;
  const limited = await post(env({ AI_RATE_LIMITER: { limit: async value => { key = value.key; return { success: false }; } } }), '/auth/email/start', { email: 'a@b.vn' });
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('Retry-After'), '60');
  assert.match(key, /^auth:[a-f0-9]{64}$/); assert.equal(key.includes('203.0.113.7'), false);
  assert.equal((await post(env({ AI_RATE_LIMITER: { limit: async () => { throw new Error('x'); } } }), '/auth/email/start', { email: 'a@b.vn' })).status, 503);
  assert.equal(calls.length, 0);
}));

test('Phiên hết hạn bị xóa và quay về trang đăng nhập; đăng xuất xóa phiên và cookie', async () => withFetch(facebook(), async () => {
  const e = env();
  const expired = sessionToken(await post(e, '/auth/facebook', { accessToken: FB_TOKEN }));
  e.DB.sqlite.prepare('UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?').run(now() - 1, sha(expired));
  const login = await get(e, '/', withSession(expired));
  assert.match(await login.text(), /Đăng nhập ShopPost/);
  assert.equal(row(e.DB, 'SELECT * FROM auth_sessions WHERE token_hash = ?', sha(expired)), null);
  assert.equal((await get(e, '/session', withSession(expired))).status, 401);

  const token = sessionToken(await post(e, '/auth/facebook', { accessToken: FB_TOKEN }));
  assert.equal((await get(e, '/session', withSession(token))).status, 200);
  const noOrigin = await worker.fetch(new Request(BASE + '/auth/logout', { method: 'POST', headers: withSession(token) }), e);
  assert.equal(noOrigin.status, 403); assert.equal((await get(e, '/session', withSession(token))).status, 200);
  const logout = await post(e, '/auth/logout', {}, withSession(token));
  assert.equal(logout.status, 200); assert.deepEqual(await logout.json(), { ok: true, next: '/' });
  const cleared = cookieNamed(logout, SESSION_COOKIE);
  assert.match(cleared, /^__Host-shopai_session=; Max-Age=0; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
  assert.equal(row(e.DB, 'SELECT * FROM auth_sessions WHERE token_hash = ?', sha(token)), null);
  assert.equal((await get(e, '/session', withSession(token))).status, 401);
  assert.equal((await get(e, '/auth/logout')).status, 405);
}));

test('Zalo: state + PKCE, callback đổi mã đúng cách và tạo phiên zalo:<id>', async () => {
  const e = env();
  const start = await get(e, '/auth/zalo/start');
  assert.equal(start.status, 302);
  const target = new URL(start.headers.get('Location'));
  assert.equal(target.origin + target.pathname, 'https://oauth.zaloapp.com/v4/permission');
  assert.equal(target.searchParams.get('app_id'), ZALO_ID);
  assert.equal(target.searchParams.get('redirect_uri'), BASE + '/auth/zalo/callback');
  const state = target.searchParams.get('state');
  assert.match(state, /^[A-Za-z0-9_-]{32}$/);
  const saved = row(e.DB, 'SELECT * FROM auth_oauth_states WHERE state = ?', state);
  assert.match(saved.verifier, /^[A-Za-z0-9]{43}$/);
  assert.equal(target.searchParams.get('code_challenge'), createHash('sha256').update(saved.verifier).digest('base64url'));
  assert.equal(start.headers.get('Location').includes(saved.verifier), false);
  const stateCookie = cookieNamed(start, '__Host-shopai_oauth');
  assert.match(stateCookie, new RegExp(`^__Host-shopai_oauth=${state}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax$`));

  await withFetch(async (url, init) => {
    if (url === 'https://oauth.zaloapp.com/v4/access_token') {
      assert.equal(init.method, 'POST'); assert.equal(init.headers.secret_key, ZALO_SECRET);
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('code'), 'ma-zalo-123'); assert.equal(form.get('code_verifier'), saved.verifier);
      assert.equal(form.get('app_id'), ZALO_ID); assert.equal(form.get('grant_type'), 'authorization_code');
      return Response.json({ access_token: 'zalo-access-token', expires_in: '3600' });
    }
    if (url.startsWith('https://graph.zalo.me/v2.0/me')) {
      assert.equal(init.headers.access_token, 'zalo-access-token');
      return Response.json({ id: '5551234', name: 'Trần Thị B', error: 0, message: 'Success' });
    }
    throw new Error('URL Zalo lạ: ' + url);
  }, async calls => {
    const callback = await get(e, `/auth/zalo/callback?code=ma-zalo-123&state=${state}`, { Cookie: `__Host-shopai_oauth=${state}` });
    assert.equal(callback.status, 302); assert.equal(callback.headers.get('Location'), '/');
    assert.match(cookieNamed(callback, '__Host-shopai_oauth'), /Max-Age=0/);
    const token = sessionToken(callback);
    assert.equal(row(e.DB, 'SELECT owner FROM auth_sessions WHERE token_hash = ?', sha(token)).owner, 'zalo:5551234');
    assert.equal(row(e.DB, 'SELECT * FROM auth_oauth_states WHERE state = ?', state), null);
    const session = await (await get(e, '/session', withSession(token))).json();
    assert.deepEqual(session.account, { provider: 'zalo', name: 'Trần Thị B' });
    assert.equal(calls.length, 2);
    // State chỉ dùng được một lần.
    const replay = await get(e, `/auth/zalo/callback?code=ma-zalo-123&state=${state}`, { Cookie: `__Host-shopai_oauth=${state}` });
    assert.equal(replay.headers.get('Location'), '/?loi=zalo_het_han'); assert.equal(calls.length, 2);
  });
});

test('Zalo: state sai/hết hạn, người dùng từ chối, lỗi token/hồ sơ và thiếu cấu hình', async () => {
  const begin = async e => new URL((await get(e, '/auth/zalo/start')).headers.get('Location')).searchParams.get('state');
  const loi = response => response.headers.get('Location');
  await withFetch(null, async calls => {
    const e = env();
    const state = await begin(e);
    assert.equal(loi(await get(e, `/auth/zalo/callback?code=x&state=${state}`)), '/?loi=zalo_state');
    assert.equal(loi(await get(e, `/auth/zalo/callback?code=x&state=${state}`, { Cookie: '__Host-shopai_oauth=' + 'b'.repeat(32) })), '/?loi=zalo_state');
    assert.equal(loi(await get(e, '/auth/zalo/callback?code=x&state=<script>', { Cookie: '__Host-shopai_oauth=<script>' })), '/?loi=zalo_state');
    const old = await begin(e);
    e.DB.sqlite.prepare('UPDATE auth_oauth_states SET expires_at = ? WHERE state = ?').run(now() - 1, old);
    assert.equal(loi(await get(e, `/auth/zalo/callback?code=x&state=${old}`, { Cookie: '__Host-shopai_oauth=' + old })), '/?loi=zalo_het_han');
    const denied = await begin(e);
    assert.equal(loi(await get(e, `/auth/zalo/callback?error=access_denied&state=${denied}`, { Cookie: '__Host-shopai_oauth=' + denied })), '/?loi=zalo_tu_choi');
    assert.equal(calls.length, 0);
    const off = env({ ZALO_APP_SECRET: undefined });
    assert.equal(loi(await get(off, '/auth/zalo/start')), '/?loi=zalo_chua_cau_hinh');
    assert.equal(loi(await get(off, `/auth/zalo/callback?code=x&state=${state}`, { Cookie: '__Host-shopai_oauth=' + state })), '/?loi=zalo_chua_cau_hinh');
  });
  for (const [handler, expected] of [
    [async () => Response.json({ error: -14014, error_name: 'Invalid code' }), '/?loi=zalo_token'],
    [async url => url.includes('access_token') ? Response.json({ access_token: 't' }) : Response.json({ error: 452, message: 'Access token invalid' }), '/?loi=zalo_ho_so'],
    [async () => { throw new Error('hết thời gian'); }, '/?loi=zalo_tam_loi']
  ]) {
    await withFetch(handler, async () => {
      const e = env();
      const state = await begin(e);
      // Zalo có thể trả mã qua tham số oauth_code.
      const response = await get(e, `/auth/zalo/callback?oauth_code=x&state=${state}`, { Cookie: '__Host-shopai_oauth=' + state });
      assert.equal(loi(response), expected); assert.equal(cookieNamed(response, SESSION_COOKIE), null);
    });
  }
});

test('Email OTP: gửi mã, chặn gửi lại quá nhanh, sai mã, đúng mã một lần', async () => {
  const sent = [];
  await withFetch(async (url, init) => {
    assert.equal(url, 'https://api.resend.com/emails'); assert.equal(init.headers.Authorization, 'Bearer ' + RESEND_KEY);
    sent.push(JSON.parse(init.body));
    return Response.json({ id: 'email-1' });
  }, async () => {
    const e = env();
    const start = await post(e, '/auth/email/start', { email: '  Khach@Example.com ' });
    assert.equal(start.status, 200); assert.deepEqual(await start.json(), { ok: true, retryAfter: 60, expiresIn: 600 });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].from, 'ShopPost <no-reply@shoppost.net>'); assert.equal(sent[0].subject, 'Mã đăng nhập ShopPost của bạn'); assert.match(sent[0].text, /^Mã đăng nhập ShopPost của bạn là \d{6}\./); assert.deepEqual(sent[0].to, ['khach@example.com']);
    const code = sent[0].text.match(/\b(\d{6})\b/)[1];
    const stored = row(e.DB, 'SELECT * FROM auth_otp_codes WHERE email = ?', 'khach@example.com');
    assert.equal(JSON.stringify(stored).includes(code), false); assert.match(stored.code_hash, /^[a-f0-9]{64}$/);
    const again = await post(e, '/auth/email/start', { email: 'khach@example.com' });
    assert.equal(again.status, 429); assert.ok(Number(again.headers.get('Retry-After')) > 0); assert.equal(sent.length, 1);
    const wrong = String((Number(code) + 1) % 1000000).padStart(6, '0');
    const bad = await post(e, '/auth/email/verify', { email: 'khach@example.com', code: wrong });
    assert.equal(bad.status, 400); assert.equal((await bad.json()).error, 'Mã không đúng. Bạn còn 4 lần thử.');
    for (const invalid of ['12345', '12a456', 123456]) assert.equal((await post(e, '/auth/email/verify', { email: 'khach@example.com', code: invalid })).status, 400);
    const ok = await post(e, '/auth/email/verify', { email: 'KHACH@example.com', code });
    assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { ok: true, provider: 'email', name: 'khach@example.com' });
    const token = sessionToken(ok);
    assert.equal(row(e.DB, 'SELECT owner FROM auth_sessions WHERE token_hash = ?', sha(token)).owner, 'email:khach@example.com');
    assert.equal((await post(e, '/auth/email/verify', { email: 'khach@example.com', code })).status, 400);
    assert.equal((await get(e, '/session', withSession(token))).status, 200);
    assert.equal((await post(e, '/auth/email/start', { email: 'khong-hop-le' })).status, 400);
    assert.equal((await post(env({ RESEND_API_KEY: undefined }), '/auth/email/start', { email: 'a@b.vn' })).status, 503);
  });
});

test('Email OTP: mã hết hạn, sai quá 5 lần, gửi quá 5 mã/giờ và lỗi gửi email', async () => {
  let last;
  const resend = async (url, init) => { last = JSON.parse(init.body).text.match(/\b(\d{6})\b/)[1]; return Response.json({ id: 'ok' }); };
  await withFetch(resend, async calls => {
    const e = env(), email = 'otp@shoppost.net';
    const rewind = () => e.DB.sqlite.prepare('UPDATE auth_otp_codes SET sent_at = sent_at - 61 WHERE email = ?').run(email);
    assert.equal((await post(e, '/auth/email/start', { email })).status, 200);
    e.DB.sqlite.prepare('UPDATE auth_otp_codes SET expires_at = ? WHERE email = ?').run(now() - 1, email);
    const expired = await post(e, '/auth/email/verify', { email, code: last });
    assert.equal(expired.status, 400); assert.match((await expired.json()).error, /hết hạn/);

    rewind();
    assert.equal((await post(e, '/auth/email/start', { email })).status, 200);
    const wrong = String((Number(last) + 7) % 1000000).padStart(6, '0');
    for (const left of [4, 3, 2, 1]) assert.equal((await (await post(e, '/auth/email/verify', { email, code: wrong })).json()).attemptsLeft, left);
    assert.equal((await post(e, '/auth/email/verify', { email, code: wrong })).status, 429);
    const locked = await post(e, '/auth/email/verify', { email, code: last });
    assert.notEqual(locked.status, 200); assert.equal(cookieNamed(locked, SESSION_COOKIE), null);

    for (let i = 0; i < 3; i++) { rewind(); assert.equal((await post(e, '/auth/email/start', { email })).status, 200); }
    assert.equal(row(e.DB, 'SELECT sent_count FROM auth_otp_codes WHERE email = ?', email).sent_count, 5);
    rewind();
    const tooMany = await post(e, '/auth/email/start', { email });
    assert.equal(tooMany.status, 429); assert.match((await tooMany.json()).error, /quá nhiều mã/);
    assert.equal(calls.length, 5);
  });
  await withFetch(async () => new Response('{"message":"invalid key"}', { status: 401 }), async () => {
    const e = env();
    const failed = await post(e, '/auth/email/start', { email: 'loi@shoppost.net' });
    assert.equal(failed.status, 502); assert.equal((await failed.text()).includes(RESEND_KEY), false);
    assert.equal(row(e.DB, 'SELECT code_hash FROM auth_otp_codes WHERE email = ?', 'loi@shoppost.net').code_hash, '');
  });
});


// ---- TikTok Login Kit, số điện thoại (OTP SMS) và thương hiệu ShopPost ----
const TIKTOK_KEY = 'awtestclientkey', TIKTOK_SECRET = 'tiktok-secret-khong-duoc-lo';
const ESMS = { ESMS_API_KEY: 'esms-api-khoa-bi-mat', ESMS_SECRET_KEY: 'esms-secret-khoa-bi-mat', ESMS_BRANDNAME: 'ShopPost' };
const TWILIO = { TWILIO_ACCOUNT_SID: 'AC' + 'a1'.repeat(16), TWILIO_AUTH_TOKEN: 'twilio-token-khong-duoc-lo', TWILIO_VERIFY_SERVICE_SID: 'VA' + 'b2'.repeat(16) };
const tiktokEnv = (overrides = {}) => env({ TIKTOK_CLIENT_KEY: TIKTOK_KEY, TIKTOK_CLIENT_SECRET: TIKTOK_SECRET, ...overrides });
const smsCode = body => body.Content.match(/\b(\d{6})\b/)[1];
const LOGIN_FILE = readFileSync(new URL('../../login.html', import.meta.url), 'utf8');
const PHONE_SAMPLES = [
  ['0912345678', '+84912345678'], ['84912345678', '+84912345678'], ['+84912345678', '+84912345678'], ['+84 912 345 678', '+84912345678'],
  ['091.234.5678', '+84912345678'], ['(+84) 912-345-678', '+84912345678'], [' 0912 345 678 ', '+84912345678'], ['+840912345678', '+84912345678'],
  ['0389999999', '+84389999999'], ['0708123456', '+84708123456'], ['0561234567', '+84561234567'], ['0861234567', '+84861234567'],
  ['', null], ['012345678', null], ['0212345678', null], ['+1 415 555 0100', null], ['09123456789', null], ['8491234567', null],
  ['0912 345 67a', null], ['abc', null], ['0912345678;DROP', null], ['0'.repeat(40), null], [912345678, null], [null, null], [undefined, null]
];

test('Chuẩn hóa số di động Việt Nam về E.164 (máy chủ và trang đăng nhập giống nhau) và code_challenge hex của TikTok', async () => {
  for (const [input, expected] of PHONE_SAMPLES) assert.equal(normalizePhone(input), expected, String(input));
  const source = LOGIN_FILE.match(/function normalizePhone\(value\) \{[\s\S]*?\n  \}/)[0];
  const client = new Function(source + '; return normalizePhone;')();
  for (const [input, expected] of PHONE_SAMPLES) assert.equal(client(input) || null, expected, 'login.html: ' + String(input));
  assert.equal(await tiktokChallenge('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const verifier = pkceVerifier();
  assert.equal(await tiktokChallenge(verifier), sha(verifier));
});

test('/auth/providers: TikTok và số điện thoại chỉ bật khi đủ cấu hình, không lộ secret', async () => {
  const p = async overrides => (await get(env(overrides), '/auth/providers')).json();
  const text = await (await get(env({ TIKTOK_CLIENT_KEY: TIKTOK_KEY, TIKTOK_CLIENT_SECRET: TIKTOK_SECRET, ...ESMS }), '/auth/providers')).text();
  const body = JSON.parse(text);
  assert.deepEqual(body.tiktok, { enabled: true }); assert.deepEqual(body.phone, { enabled: true });
  for (const secret of [TIKTOK_SECRET, ESMS.ESMS_API_KEY, ESMS.ESMS_SECRET_KEY]) assert.equal(text.includes(secret), false);
  assert.equal((await p({ TIKTOK_CLIENT_KEY: TIKTOK_KEY })).tiktok.enabled, false);
  assert.equal((await p({ TIKTOK_CLIENT_KEY: 'khóa có dấu', TIKTOK_CLIENT_SECRET: TIKTOK_SECRET })).tiktok.enabled, false);
  assert.equal((await p({ TIKTOK_CLIENT_KEY: TIKTOK_KEY, TIKTOK_CLIENT_SECRET: TIKTOK_SECRET, DB: undefined })).tiktok.enabled, false);
  assert.equal((await p({ ...ESMS, ESMS_BRANDNAME: undefined })).phone.enabled, false);
  assert.equal((await p({ ...ESMS, ESMS_SECRET_KEY: ' ' })).phone.enabled, false);
  assert.equal((await p({ ...ESMS, DB: undefined })).phone.enabled, false);
  const twilioText = await (await get(env(TWILIO), '/auth/providers')).text();
  assert.equal(JSON.parse(twilioText).phone.enabled, true); assert.equal(twilioText.includes(TWILIO.TWILIO_AUTH_TOKEN), false);
  assert.equal((await p({ ...TWILIO, TWILIO_ACCOUNT_SID: 'sai-dinh-dang' })).phone.enabled, false);
  assert.equal((await p({ ...TWILIO, TWILIO_AUTH_TOKEN: undefined })).phone.enabled, false);
  assert.equal((await p({ ...TWILIO, TWILIO_VERIFY_SERVICE_SID: 'MG' + 'b2'.repeat(16) })).phone.enabled, false);
  const onlyPhone = await p({ FACEBOOK_APP_ID: undefined, ZALO_APP_SECRET: undefined, RESEND_API_KEY: undefined, ...ESMS });
  assert.equal(onlyPhone.ready, true); assert.equal(onlyPhone.email.enabled, false);
  assert.equal((await p({ FACEBOOK_APP_ID: undefined, ZALO_APP_SECRET: undefined, RESEND_API_KEY: undefined, TIKTOK_CLIENT_KEY: TIKTOK_KEY, TIKTOK_CLIENT_SECRET: TIKTOK_SECRET })).ready, true);
});

test('TikTok: state + PKCE (hex), callback đổi mã đúng cách và tạo phiên tiktok:<open_id>', async () => {
  const e = tiktokEnv();
  const start = await get(e, '/auth/tiktok/start');
  assert.equal(start.status, 302);
  const location = start.headers.get('Location'), target = new URL(location);
  assert.equal(target.origin + target.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
  assert.equal(target.searchParams.get('client_key'), TIKTOK_KEY);
  assert.equal(target.searchParams.get('scope'), 'user.info.basic');
  assert.equal(target.searchParams.get('response_type'), 'code');
  assert.equal(target.searchParams.get('redirect_uri'), BASE + '/auth/tiktok/callback');
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  const state = target.searchParams.get('state');
  assert.match(state, /^[A-Za-z0-9_-]{32}$/);
  const saved = row(e.DB, 'SELECT * FROM auth_oauth_states WHERE state = ?', state);
  assert.equal(saved.provider, 'tiktok'); assert.match(saved.verifier, /^[A-Za-z0-9]{43}$/);
  assert.equal(target.searchParams.get('code_challenge'), sha(saved.verifier));
  assert.equal(target.searchParams.get('code_challenge'), await tiktokChallenge(saved.verifier));
  assert.equal(location.includes(saved.verifier), false); assert.equal(location.includes(TIKTOK_SECRET), false);
  assert.match(cookieNamed(start, '__Host-shopai_oauth'), new RegExp(`^__Host-shopai_oauth=${state}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax$`));

  await withFetch(async (url, init) => {
    if (url === 'https://open.tiktokapis.com/v2/oauth/token/') {
      assert.equal(init.method, 'POST'); assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
      assert.deepEqual(Object.fromEntries(new URLSearchParams(init.body)), { client_key: TIKTOK_KEY, client_secret: TIKTOK_SECRET, code: 'ma-tiktok-123', grant_type: 'authorization_code', redirect_uri: BASE + '/auth/tiktok/callback', code_verifier: saved.verifier });
      return Response.json({ access_token: 'act.tiktok-access', open_id: 'tt-open-1', scope: 'user.info.basic', expires_in: 86400, token_type: 'Bearer' });
    }
    if (url.startsWith('https://open.tiktokapis.com/v2/user/info/')) {
      assert.equal(new URL(url).searchParams.get('fields'), 'open_id,union_id,display_name,avatar_url');
      assert.equal(init.headers.Authorization, 'Bearer act.tiktok-access');
      return Response.json({ data: { user: { open_id: 'tt-open-1', union_id: 'u-1', display_name: 'Lê <b>Văn</b> C' } }, error: { code: 'ok', message: '', log_id: 'log-1' } });
    }
    throw new Error('URL TikTok lạ: ' + url);
  }, async calls => {
    const callback = await get(e, `/auth/tiktok/callback?code=ma-tiktok-123&scopes=user.info.basic&state=${state}`, { Cookie: `__Host-shopai_oauth=${state}` });
    assert.equal(callback.status, 302); assert.equal(callback.headers.get('Location'), '/');
    assert.match(cookieNamed(callback, '__Host-shopai_oauth'), /Max-Age=0/);
    const token = sessionToken(callback);
    const savedSession = row(e.DB, 'SELECT owner, provider FROM auth_sessions WHERE token_hash = ?', sha(token));
    assert.equal(savedSession.owner, 'tiktok:tt-open-1'); assert.equal(savedSession.provider, 'tiktok');
    assert.equal(row(e.DB, 'SELECT * FROM auth_oauth_states WHERE state = ?', state), null);
    const session = await (await get(e, '/session', withSession(token))).json();
    assert.equal(session.userScope, sha('tiktok:tt-open-1'));
    assert.deepEqual(session.account, { provider: 'tiktok', name: 'Lê bVăn/b C' });
    assert.equal(calls.length, 2);
    const replay = await get(e, `/auth/tiktok/callback?code=ma-tiktok-123&state=${state}`, { Cookie: `__Host-shopai_oauth=${state}` });
    assert.equal(replay.headers.get('Location'), '/?loi=tiktok_het_han'); assert.equal(calls.length, 2);
  });
});

test('TikTok: state sai, state của Zalo, người dùng từ chối, lỗi token/hồ sơ/mạng và thiếu cấu hình', async () => {
  const begin = async (e, provider = 'tiktok') => new URL((await get(e, `/auth/${provider}/start`)).headers.get('Location')).searchParams.get('state');
  const loi = response => response.headers.get('Location');
  const cookie = state => ({ Cookie: '__Host-shopai_oauth=' + state });
  await withFetch(null, async calls => {
    const e = tiktokEnv();
    const state = await begin(e);
    assert.equal(loi(await get(e, `/auth/tiktok/callback?code=x&state=${state}`)), '/?loi=tiktok_state');
    assert.equal(loi(await get(e, `/auth/tiktok/callback?code=x&state=${state}`, cookie('c'.repeat(32)))), '/?loi=tiktok_state');
    assert.equal(loi(await get(e, '/auth/tiktok/callback?code=x&state=<script>', cookie('<script>'))), '/?loi=tiktok_state');
    assert.equal(loi(await get(e, `/auth/tiktok/callback?code=x&state=${'d'.repeat(32)}`, cookie('d'.repeat(32)))), '/?loi=tiktok_het_han');
    // State tạo cho Zalo không dùng được cho TikTok và không bị tiêu thụ.
    const zaloState = await begin(e, 'zalo');
    assert.equal(loi(await get(e, `/auth/tiktok/callback?code=x&state=${zaloState}`, cookie(zaloState))), '/?loi=tiktok_het_han');
    assert.equal(row(e.DB, 'SELECT provider FROM auth_oauth_states WHERE state = ?', zaloState).provider, 'zalo');
    const old = await begin(e);
    e.DB.sqlite.prepare('UPDATE auth_oauth_states SET expires_at = ? WHERE state = ?').run(now() - 1, old);
    assert.equal(loi(await get(e, `/auth/tiktok/callback?code=x&state=${old}`, cookie(old))), '/?loi=tiktok_het_han');
    const denied = await begin(e);
    assert.equal(loi(await get(e, `/auth/tiktok/callback?error=access_denied&error_description=x&state=${denied}`, cookie(denied))), '/?loi=tiktok_tu_choi');
    assert.equal(row(e.DB, 'SELECT * FROM auth_oauth_states WHERE state = ?', denied), null);
    const withError = await begin(e);
    assert.equal(loi(await get(e, `/auth/tiktok/callback?code=x&error=access_denied&state=${withError}`, cookie(withError))), '/?loi=tiktok_tu_choi');
    // Tham số oauth_code chỉ dành cho Zalo.
    const oauthCode = await begin(e);
    assert.equal(loi(await get(e, `/auth/tiktok/callback?oauth_code=x&state=${oauthCode}`, cookie(oauthCode))), '/?loi=tiktok_tu_choi');
    assert.equal(calls.length, 0);
    assert.equal(loi(await get(env(), '/auth/tiktok/start')), '/?loi=tiktok_chua_cau_hinh');
    assert.equal(loi(await get(env({ TIKTOK_CLIENT_KEY: TIKTOK_KEY }), `/auth/tiktok/callback?code=x&state=${state}`, cookie(state))), '/?loi=tiktok_chua_cau_hinh');
  });
  const tokenOk = profile => async url => url.includes('/oauth/token/') ? Response.json({ access_token: 'act.x' }) : profile();
  for (const [handler, expected] of [
    [async () => Response.json({ error: 'invalid_grant', error_description: 'Authorization code is expired.', log_id: 'x' }), '/?loi=tiktok_token'],
    [async () => Response.json({ access_token: 'act.x', error: 'invalid_request' }), '/?loi=tiktok_token'],
    [async () => new Response('lỗi', { status: 500 }), '/?loi=tiktok_token'],
    [tokenOk(() => Response.json({ data: {}, error: { code: 'access_token_invalid', message: 'x' } }, { status: 401 })), '/?loi=tiktok_ho_so'],
    [tokenOk(() => Response.json({ data: { user: { open_id: 'có dấu <script>' } }, error: { code: 'ok' } })), '/?loi=tiktok_ho_so'],
    [tokenOk(() => Response.json({ data: { user: { open_id: 'tt-1' } }, error: { code: 'scope_not_authorized' } })), '/?loi=tiktok_ho_so'],
    [async () => { throw new Error('hết thời gian chi tiết nội bộ'); }, '/?loi=tiktok_tam_loi']
  ]) {
    await withFetch(handler, async () => {
      const e = tiktokEnv();
      const state = await begin(e);
      const response = await get(e, `/auth/tiktok/callback?code=x&state=${state}`, cookie(state));
      assert.equal(loi(response), expected); assert.equal(cookieNamed(response, SESSION_COOKIE), null);
      assert.equal(rows(e.DB, 'SELECT * FROM auth_sessions').length, 0);
    });
  }
});

test('Số điện thoại (eSMS): gửi mã, chặn gửi lại nhanh, sai mã, đúng mã một lần, tạo phiên phone:<E.164>', async () => {
  const sent = [];
  await withFetch(async (url, init) => {
    assert.equal(url, 'https://rest.esms.vn/MainService.svc/json/SendMultipleMessage_V4_post_json/');
    assert.equal(init.method, 'POST'); assert.equal(init.headers['Content-Type'], 'application/json');
    sent.push(JSON.parse(init.body));
    return Response.json({ CodeResult: '100', CountRegenerate: 0, SMSID: 'sms-1' });
  }, async () => {
    const e = env(ESMS), phone = '+84912345678';
    const start = await post(e, '/auth/phone/start', { phone: '0912 345 678' });
    assert.equal(start.status, 200); assert.deepEqual(await start.json(), { ok: true, retryAfter: 60, expiresIn: 600 });
    assert.equal(sent.length, 1);
    const message = sent[0];
    assert.equal(message.ApiKey, ESMS.ESMS_API_KEY); assert.equal(message.SecretKey, ESMS.ESMS_SECRET_KEY); assert.equal(message.Brandname, 'ShopPost');
    assert.equal(message.Phone, '0912345678'); assert.equal(message.SmsType, '2'); assert.equal(message.IsUnicode, '1'); assert.match(message.RequestId, /^[A-Za-z0-9_-]{24}$/);
    assert.match(message.Content, /^Mã đăng nhập ShopPost của bạn là \d{6}\. Hiệu lực 10 phút\./);
    const code = smsCode(message);
    const stored = row(e.DB, 'SELECT * FROM auth_otp_codes WHERE email = ?', phone);
    assert.equal(JSON.stringify(stored).includes(code), false); assert.match(stored.code_hash, /^[a-f0-9]{64}$/);
    const again = await post(e, '/auth/phone/start', { phone: '+84 912 345 678' });
    assert.equal(again.status, 429); assert.ok(Number(again.headers.get('Retry-After')) > 0); assert.equal(sent.length, 1);
    const wrong = String((Number(code) + 1) % 1000000).padStart(6, '0');
    const bad = await post(e, '/auth/phone/verify', { phone, code: wrong });
    assert.equal(bad.status, 400); assert.equal((await bad.json()).error, 'Mã không đúng. Bạn còn 4 lần thử.');
    assert.equal((await post(e, '/auth/email/verify', { email: phone, code })).status, 400);
    const ok = await post(e, '/auth/phone/verify', { phone: '84912345678', code });
    assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { ok: true, provider: 'phone', name: phone });
    const token = sessionToken(ok);
    assert.equal(row(e.DB, 'SELECT owner FROM auth_sessions WHERE token_hash = ?', sha(token)).owner, 'phone:+84912345678');
    const session = await (await get(e, '/session', withSession(token))).json();
    assert.equal(session.userScope, sha('phone:+84912345678')); assert.deepEqual(session.account, { provider: 'phone', name: phone });
    assert.equal((await post(e, '/auth/phone/verify', { phone, code })).status, 400);
    for (const invalid of ['', '012345678', '+1 415 555 0100', 'abc', 912345678, null]) {
      const response = await post(e, '/auth/phone/start', { phone: invalid });
      assert.equal(response.status, 400); assert.match((await response.json()).error, /^Số điện thoại không hợp lệ/);
    }
    assert.equal((await post(e, '/auth/phone/verify', { phone, code: '12a456' })).status, 400);
    assert.equal(sent.length, 1);
    const off = await post(env(), '/auth/phone/start', { phone: '0912345678' });
    assert.equal(off.status, 503); assert.equal((await off.json()).error, 'Đăng nhập bằng số điện thoại chưa được kích hoạt.');
  });
});

test('Số điện thoại (eSMS): mã hết hạn, sai quá 5 lần, quá 5 mã/giờ và lỗi gửi SMS không lộ khóa', async () => {
  let last;
  await withFetch(async (url, init) => { last = smsCode(JSON.parse(init.body)); return Response.json({ CodeResult: '100' }); }, async calls => {
    const e = env(ESMS), phone = '0987654321', key = '+84987654321';
    const rewind = () => e.DB.sqlite.prepare('UPDATE auth_otp_codes SET sent_at = sent_at - 61 WHERE email = ?').run(key);
    assert.equal((await post(e, '/auth/phone/start', { phone })).status, 200);
    e.DB.sqlite.prepare('UPDATE auth_otp_codes SET expires_at = ? WHERE email = ?').run(now() - 1, key);
    const expired = await post(e, '/auth/phone/verify', { phone, code: last });
    assert.equal(expired.status, 400); assert.match((await expired.json()).error, /hết hạn/);

    rewind();
    assert.equal((await post(e, '/auth/phone/start', { phone })).status, 200);
    const wrong = String((Number(last) + 7) % 1000000).padStart(6, '0');
    for (const left of [4, 3, 2, 1]) assert.equal((await (await post(e, '/auth/phone/verify', { phone, code: wrong })).json()).attemptsLeft, left);
    assert.equal((await post(e, '/auth/phone/verify', { phone, code: wrong })).status, 429);
    const locked = await post(e, '/auth/phone/verify', { phone, code: last });
    assert.notEqual(locked.status, 200); assert.equal(cookieNamed(locked, SESSION_COOKIE), null);

    for (let i = 0; i < 3; i++) { rewind(); assert.equal((await post(e, '/auth/phone/start', { phone })).status, 200); }
    rewind();
    const tooMany = await post(e, '/auth/phone/start', { phone });
    assert.equal(tooMany.status, 429); assert.match((await tooMany.json()).error, /quá nhiều mã cho số điện thoại này/);
    assert.equal(calls.length, 5);
  });
  await withFetch(async () => Response.json({ CodeResult: '101', ErrorMessage: 'Authorize Failed' }), async () => {
    const e = env(ESMS);
    const failed = await post(e, '/auth/phone/start', { phone: '0912345678' });
    assert.equal(failed.status, 502);
    const text = await failed.text();
    assert.equal(JSON.parse(text).error, 'Không gửi được tin nhắn SMS lúc này. Vui lòng thử lại sau ít phút.');
    for (const secret of [ESMS.ESMS_API_KEY, ESMS.ESMS_SECRET_KEY]) assert.equal(text.includes(secret), false);
    assert.equal(row(e.DB, 'SELECT code_hash FROM auth_otp_codes WHERE email = ?', '+84912345678').code_hash, '');
  });
  await withFetch(async () => { throw new Error('mạng lỗi'); }, async () => {
    assert.equal((await post(env(ESMS), '/auth/phone/start', { phone: '0912345678' })).status, 502);
  });
});

test('Số điện thoại (Twilio Verify): Twilio gửi và kiểm mã, Worker vẫn áp giới hạn; eSMS được ưu tiên khi có cả hai', async () => {
  const base = `https://verify.twilio.com/v2/Services/${TWILIO.TWILIO_VERIFY_SERVICE_SID}/`;
  const auth = 'Basic ' + Buffer.from(TWILIO.TWILIO_ACCOUNT_SID + ':' + TWILIO.TWILIO_AUTH_TOKEN).toString('base64');
  const calls = [];
  let checkStatus = 'pending', checkHttp = 200;
  await withFetch(async (url, init) => {
    calls.push({ url, form: Object.fromEntries(new URLSearchParams(init.body)) });
    assert.equal(init.method, 'POST'); assert.equal(init.headers.Authorization, auth);
    assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    if (url === base + 'Verifications') return Response.json({ sid: 'VE1', status: 'pending', to: '+84912345678' }, { status: 201 });
    if (url === base + 'VerificationCheck') return checkHttp === 200 ? Response.json({ status: checkStatus, valid: checkStatus === 'approved' }) : Response.json({ code: 20404, message: 'not found' }, { status: checkHttp });
    throw new Error('URL Twilio lạ: ' + url);
  }, async () => {
    const e = env(TWILIO), phone = '+84912345678';
    assert.equal((await post(e, '/auth/phone/start', { phone: '0912345678' })).status, 200);
    assert.equal(calls.length, 1); assert.deepEqual(calls[0].form, { To: phone, Channel: 'sms' });
    assert.equal(row(e.DB, 'SELECT code_hash FROM auth_otp_codes WHERE email = ?', phone).code_hash, 'twilio-verify');
    assert.equal((await post(e, '/auth/phone/start', { phone })).status, 429); assert.equal(calls.length, 1);
    const bad = await post(e, '/auth/phone/verify', { phone, code: '111111' });
    assert.equal(bad.status, 400); assert.equal((await bad.json()).attemptsLeft, 4);
    assert.equal(calls[1].url, base + 'VerificationCheck'); assert.deepEqual(calls[1].form, { To: phone, Code: '111111' });
    checkStatus = 'approved';
    const ok = await post(e, '/auth/phone/verify', { phone, code: '222222' });
    assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { ok: true, provider: 'phone', name: phone });
    assert.equal(row(e.DB, 'SELECT owner FROM auth_sessions WHERE token_hash = ?', sha(sessionToken(ok))).owner, 'phone:+84912345678');
    assert.equal(row(e.DB, 'SELECT * FROM auth_otp_codes WHERE email = ?', phone), null);
    // Twilio báo 404 (hết hạn/đã dùng/quá số lần) → yêu cầu gửi mã mới, lần sau không gọi Twilio nữa.
    assert.equal((await post(e, '/auth/phone/start', { phone })).status, 200);
    checkHttp = 404;
    const expired = await post(e, '/auth/phone/verify', { phone, code: '333333' });
    assert.equal(expired.status, 400); assert.match((await expired.json()).error, /hết hạn/);
    const before = calls.length;
    assert.equal((await post(e, '/auth/phone/verify', { phone, code: '333333' })).status, 400); assert.equal(calls.length, before);
    // Twilio lỗi máy chủ khi kiểm mã → 503, không tạo phiên.
    e.DB.sqlite.prepare('UPDATE auth_otp_codes SET sent_at = sent_at - 61 WHERE email = ?').run(phone);
    assert.equal((await post(e, '/auth/phone/start', { phone })).status, 200);
    checkHttp = 500;
    const down = await post(e, '/auth/phone/verify', { phone, code: '444444' });
    assert.equal(down.status, 503); assert.equal(cookieNamed(down, SESSION_COOKIE), null);
  });
  await withFetch(async () => Response.json({ code: 20003, message: 'Authenticate' }, { status: 401 }), async () => {
    const e = env(TWILIO);
    const failed = await post(e, '/auth/phone/start', { phone: '0912345678' });
    assert.equal(failed.status, 502); assert.equal((await failed.text()).includes(TWILIO.TWILIO_AUTH_TOKEN), false);
    assert.equal(row(e.DB, 'SELECT code_hash FROM auth_otp_codes WHERE email = ?', '+84912345678').code_hash, '');
  });
  await withFetch(async url => { assert.ok(url.startsWith('https://rest.esms.vn/')); return Response.json({ CodeResult: '100' }); }, async calls => {
    assert.equal((await post(env({ ...ESMS, ...TWILIO }), '/auth/phone/start', { phone: '0912345678' })).status, 200);
    assert.equal(calls.length, 1);
  });
});

test('Thương hiệu ShopPost: giao diện hiển thị ShopPost, giữ định danh kỹ thuật shopai; trang đăng nhập đủ 5 phương thức đúng thứ tự', async () => {
  const index = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const TECH = /shopai-ai-endpoint|shopai-user-scope|X-ShopAI-User-Scope|__Host-shopai_\w+|SHOPAI_RELEASE_SHA|shopai-backend|shopai-drafts[\w-]*/g;
  for (const [name, text] of [['login.html', LOGIN_FILE], ['index.html', index], ['README.md', readme]]) {
    assert.ok(text.includes('ShopPost'), name);
    assert.doesNotMatch(text.replace(TECH, ''), /shop\s?ai/i, name);
  }
  assert.match(index, /<title>ShopPost × ShopTrack/); assert.match(index, /name="shopai-ai-endpoint"/); assert.match(index, /name="shopai-user-scope"/);
  assert.match(LOGIN_FILE, /<title>Đăng nhập ShopPost<\/title>/); assert.ok(LOGIN_FILE.includes('© ShopPost × ShopTrack'));
  const order = ['id="zalo"', 'id="fb"', 'id="tiktok"', 'id="phoneBtn"', 'id="emailForm"'].map(id => LOGIN_FILE.indexOf(id));
  assert.ok(order.every(i => i > 0), JSON.stringify(order)); assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(LOGIN_FILE, /<a id="tiktok" class="btn tiktok" href="\/auth\/tiktok\/start" hidden>/);
  assert.match(LOGIN_FILE, /<input id="phone"[^>]*type="tel"[^>]*inputmode="tel"/);
  // CSP trang đăng nhập không thêm nguồn ngoài cho TikTok/SMS (TikTok điều hướng toàn trang, SMS gửi từ máy chủ).
  const csp = (await get(env({ TIKTOK_CLIENT_KEY: TIKTOK_KEY, TIKTOK_CLIENT_SECRET: TIKTOK_SECRET, ...ESMS }), '/')).headers.get('Content-Security-Policy');
  assert.doesNotMatch(csp, /tiktok|esms|twilio/i);
  // Mobile: body chỉ đặt min-height (không cố định height) để nội dung cao hơn màn hình không bị đẩy mất phần đầu.
  assert.match(LOGIN_FILE, /body\{min-height:100%;/); assert.doesNotMatch(LOGIN_FILE, /html,body\{height:100%\}/);
});
