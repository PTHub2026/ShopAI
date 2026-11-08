import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
const worker = (await import(new URL('../src/worker.js', import.meta.url))).default;
const { AUTH_SCHEMA, SESSION_COOKIE, normalizeEmail, pkceChallenge, pkceVerifier, sameText } = await import(new URL('../src/auth.js', import.meta.url));

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

const LOGIN_HTML = '<!DOCTYPE html><html lang="vi"><head><script nonce="__CSP_NONCE__">window.dangNhap=1</script></head><body><h1>Đăng nhập ShopAI</h1></body></html>';
function env(overrides = {}) {
  return {
    ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com', ACCESS_AUD: 'test-audience', ALLOWED_ORIGINS: 'https://pthub2026.github.io',
    AI: { run: async () => ({ response: 'Nội dung AI' }) }, AI_RATE_LIMITER: { limit: async () => ({ success: true }) }, DB: database(),
    FACEBOOK_APP_ID: FB_ID, ZALO_APP_ID: ZALO_ID, ZALO_APP_SECRET: ZALO_SECRET, RESEND_API_KEY: RESEND_KEY, EMAIL_FROM: 'ShopAI <no-reply@shoppost.net>',
    FRONTEND_HTML: '<html><head></head><body>Ứng dụng ShopAI</body></html>', LOGIN_HTML, ...overrides
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
  if (url.startsWith('https://graph.facebook.com/v21.0/app?access_token=')) return Response.json({ id: appId, name: 'ShopAI' });
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
  assert.deepEqual(off, { facebook: { enabled: false }, zalo: { enabled: false }, email: { enabled: false }, access: { url: issuer }, ready: false });
  const response = await get(env(), '/auth/providers');
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { facebook: { enabled: true, appId: FB_ID }, zalo: { enabled: true }, email: { enabled: true }, access: { url: issuer }, ready: true });
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
    assert.match(html, /Đăng nhập ShopAI/); assert.doesNotMatch(html, /shopai-user-scope|Ứng dụng ShopAI|__CSP_NONCE__/);
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
  assert.match(await login.text(), /Đăng nhập ShopAI/);
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
    assert.equal(sent[0].from, 'ShopAI <no-reply@shoppost.net>'); assert.deepEqual(sent[0].to, ['khach@example.com']);
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
