// Đăng nhập bằng phiên riêng của ShopAI (Facebook, Zalo, Email OTP), chạy song song với Cloudflare Access.
const enc = new TextEncoder();
export const SESSION_COOKIE = '__Host-shopai_session';
const STATE_COOKIE = '__Host-shopai_oauth';
const SESSION_TTL = 30 * 24 * 3600;
const STATE_TTL = 600;
const OTP_TTL = 600, OTP_MAX_ATTEMPTS = 5, OTP_RESEND_AFTER = 60, OTP_MAX_PER_HOUR = 5;
const FB_API = 'https://graph.facebook.com/v21.0';
const ZALO_AUTHORIZE = 'https://oauth.zaloapp.com/v4/permission';
const ZALO_TOKEN = 'https://oauth.zaloapp.com/v4/access_token';
const ZALO_PROFILE = 'https://graph.zalo.me/v2.0/me?fields=id,name,picture';
const RESEND_API = 'https://api.resend.com/emails';
// Giữ đồng bộ với backend/migrations/0002_auth.sql (kiểm thử so khớp hai nơi).
export const AUTH_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS auth_identities (owner TEXT PRIMARY KEY, provider TEXT NOT NULL, display_name TEXT, created_at INTEGER NOT NULL, last_login_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, owner TEXT NOT NULL, provider TEXT NOT NULL, display_name TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS auth_sessions_expires ON auth_sessions(expires_at)',
  'CREATE TABLE IF NOT EXISTS auth_otp_codes (email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, salt TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL, window_start INTEGER NOT NULL, sent_count INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS auth_oauth_states (state TEXT PRIMARY KEY, provider TEXT NOT NULL, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL)'
];
const FALLBACK_LOGIN = '<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Đăng nhập ShopAI</title></head><body><main><h1>ShopAI</h1><p>Vui lòng đăng nhập để tiếp tục. Trang đăng nhập đang được cập nhật, hãy tải lại sau ít phút.</p></main></body></html>';

const now = () => Math.floor(Date.now() / 1000);
const clean = value => typeof value === 'string' ? value.trim() : '';
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomToken = (size = 32) => b64url(crypto.getRandomValues(new Uint8Array(size)));
const sha256 = async text => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const hashHex = async text => hex(await sha256(text));
// So sánh thời gian hằng: không dừng sớm ở ký tự khác đầu tiên.
export function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}
// PKCE: code_verifier 43 ký tự [A-Za-z0-9], code_challenge = Base64Url(SHA-256(verifier)) không padding.
export function pkceVerifier(length = 43) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  while (out.length < length) for (const b of crypto.getRandomValues(new Uint8Array(64))) if (b < 248 && out.length < length) out += alphabet[b % 62];
  return out;
}
export const pkceChallenge = async verifier => b64url(await sha256(verifier));
function otpCode() {
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= 4294000000);
  return String(buf[0] % 1000000).padStart(6, '0');
}
function readCookie(request, name) {
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
const setCookie = (name, value, maxAge) => `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
const displayName = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 80) : '';
const validEmailFrom = value => { const v = clean(value); return v.length > 3 && v.length <= 200 && v.includes('@') && !/[\r\n]/.test(v); };
export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254) return null;
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(email) ? email : null;
}

export function providers(env) {
  const db = Boolean(env.DB);
  const facebookId = clean(env.FACEBOOK_APP_ID), zaloId = clean(env.ZALO_APP_ID);
  const team = clean(env.ACCESS_TEAM_DOMAIN);
  const facebook = db && /^\d{5,20}$/.test(facebookId);
  const zalo = db && /^\d{5,25}$/.test(zaloId) && Boolean(clean(env.ZALO_APP_SECRET));
  const email = db && Boolean(clean(env.RESEND_API_KEY)) && validEmailFrom(env.EMAIL_FROM);
  return {
    facebook: facebook ? { enabled: true, appId: facebookId } : { enabled: false },
    zalo: { enabled: zalo },
    email: { enabled: email },
    access: /^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(team) ? { url: 'https://' + team } : null,
    ready: facebook || zalo || email
  };
}

const ready = new WeakSet();
export async function ensureSchema(db) {
  if (ready.has(db)) return;
  await db.batch(AUTH_SCHEMA.map(sql => db.prepare(sql)));
  ready.add(db);
}

export async function sessionFromRequest(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!env.DB || !token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  try {
    await ensureSchema(env.DB);
    const tokenHash = await hashHex(token);
    const row = await env.DB.prepare('SELECT owner, provider, display_name, expires_at FROM auth_sessions WHERE token_hash = ?').bind(tokenHash).first();
    if (!row) return null;
    if (!(Number(row.expires_at) > now())) {
      await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(tokenHash).run();
      return null;
    }
    return { owner: row.owner, provider: row.provider, name: row.display_name || '' };
  } catch { return null; }
}

async function createSession(env, owner, provider, name) {
  await ensureSchema(env.DB);
  const token = randomToken(32), t = now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').bind(t),
    env.DB.prepare('INSERT INTO auth_sessions (token_hash, owner, provider, display_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').bind(await hashHex(token), owner, provider, name, t, t + SESSION_TTL),
    env.DB.prepare('INSERT INTO auth_identities (owner, provider, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner) DO UPDATE SET display_name = excluded.display_name, last_login_at = excluded.last_login_at').bind(owner, provider, name, t, t)
  ]);
  return setCookie(SESSION_COOKIE, token, SESSION_TTL);
}

export function loginResponse(env, method) {
  const nonce = randomToken(16);
  const html = (typeof env.LOGIN_HTML === 'string' ? env.LOGIN_HTML : FALLBACK_LOGIN).replaceAll('__CSP_NONCE__', nonce);
  return new Response(method === 'HEAD' ? null : html, { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Strict-Transport-Security': 'max-age=15552000; includeSubDomains', 'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    // Chỉ trang đăng nhập được nạp Facebook SDK; CSP của trang ứng dụng chính không thay đổi.
    'Content-Security-Policy': `default-src 'self'; script-src 'self' 'nonce-${nonce}' https://connect.facebook.net; connect-src 'self' https://graph.facebook.com https://*.facebook.com; frame-src https://*.facebook.com; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'`
  } });
}

async function readJson(request, max = 8192) {
  if ((request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') throw new Error('TYPE');
  if (!request.body) throw new Error('EMPTY');
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new Error('SIZE'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('SHAPE');
  return body;
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(8000) });
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  return { ok: response.ok, status: response.status, data };
}

export async function handleAuth(request, env, { json, headers, accessUser }) {
  const url = new URL(request.url);
  const path = url.pathname;
  const origin = request.headers.get('Origin');
  // Đăng nhập chỉ phục vụ cùng origin; kể cả origin trong danh sách CORS cũng bị từ chối.
  if (origin && origin !== url.origin) return json({ error: 'Nguồn truy cập không được phép.' }, 403);
  const respond = (data, status = 200, cookies = [], extra = {}) => {
    const h = new Headers({ ...headers, ...extra });
    for (const c of cookies) h.append('Set-Cookie', c);
    return new Response(JSON.stringify(data), { status, headers: h });
  };
  const redirect = (location, cookies = []) => {
    const h = new Headers({ ...headers, Location: location });
    h.delete('Content-Type');
    for (const c of cookies) h.append('Set-Cookie', c);
    return new Response(null, { status: 302, headers: h });
  };
  const routes = {
    '/auth/providers': 'GET', '/auth/zalo/start': 'GET', '/auth/zalo/callback': 'GET',
    '/auth/facebook': 'POST', '/auth/email/start': 'POST', '/auth/email/verify': 'POST', '/auth/logout': 'POST'
  };
  if (!routes[path]) return json({ error: 'Không tìm thấy endpoint.' }, 404);
  if (request.method !== routes[path]) return json({ error: 'Chỉ hỗ trợ ' + routes[path] + '.' }, 405, { Allow: routes[path] });
  if (path === '/auth/providers') return json(providers(env));
  const available = providers(env);

  if (routes[path] === 'POST') {
    // Chống CSRF: POST đăng nhập/đăng xuất bắt buộc có Origin trùng origin của Worker.
    if (origin !== url.origin) return json({ error: 'Yêu cầu không hợp lệ (thiếu Origin cùng nguồn).' }, 403);
    if (path === '/auth/logout') {
      const token = readCookie(request, SESSION_COOKIE);
      if (env.DB && token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
        try { await ensureSchema(env.DB); await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(await hashHex(token)).run(); }
        catch { return json({ error: 'Không thể đăng xuất lúc này. Vui lòng thử lại.' }, 503); }
      }
      const viaAccess = accessUser ? await accessUser() : false;
      return respond({ ok: true, next: viaAccess ? '/cdn-cgi/access/logout' : '/' }, 200, [setCookie(SESSION_COOKIE, '', 0)]);
    }
    // Giới hạn tần suất theo IP cho mọi thao tác đăng nhập (khóa đã băm, không lưu IP thô).
    try {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const limit = await env.AI_RATE_LIMITER.limit({ key: 'auth:' + await hashHex(ip) });
      if (!limit || typeof limit.success !== 'boolean') throw new Error('RATE_LIMIT_UNAVAILABLE');
      if (!limit.success) return json({ error: 'Bạn thao tác quá nhanh. Vui lòng thử lại sau 1 phút.' }, 429, { 'Retry-After': '60' });
    } catch { return json({ error: 'Dịch vụ giới hạn tần suất tạm thời không khả dụng.' }, 503); }
    let body;
    try { body = await readJson(request); } catch { return json({ error: 'Dữ liệu gửi lên không hợp lệ.' }, 400); }

    if (path === '/auth/facebook') {
      if (!available.facebook.enabled) return json({ error: 'Đăng nhập Facebook chưa được kích hoạt.' }, 503);
      const token = body.accessToken;
      if (typeof token !== 'string' || token.length < 20 || token.length > 4096 || !/^[A-Za-z0-9._|%-]+$/.test(token)) return json({ error: 'Mã truy cập Facebook không hợp lệ.' }, 400);
      try {
        const app = await fetchJson(FB_API + '/app?access_token=' + encodeURIComponent(token));
        if (!app.ok || !app.data || String(app.data.id) !== available.facebook.appId) return json({ error: 'Phiên Facebook không thuộc ứng dụng ShopAI. Vui lòng đăng nhập lại.' }, 401);
        const me = await fetchJson(FB_API + '/me?fields=id,name&access_token=' + encodeURIComponent(token));
        const id = me.data && String(me.data.id);
        if (!me.ok || !/^\d{1,32}$/.test(id || '')) return json({ error: 'Không đọc được hồ sơ Facebook.' }, 401);
        const name = displayName(me.data.name);
        const cookie = await createSession(env, 'fb:' + id, 'facebook', name);
        return respond({ ok: true, provider: 'facebook', name }, 200, [cookie]);
      } catch { return json({ error: 'Không kết nối được Facebook lúc này. Vui lòng thử lại.' }, 502); }
    }

    // Email OTP
    if (!available.email.enabled) return json({ error: 'Đăng nhập bằng email chưa được kích hoạt.' }, 503);
    const email = normalizeEmail(body.email);
    if (!email) return json({ error: 'Địa chỉ email không hợp lệ.' }, 400);
    try { await ensureSchema(env.DB); } catch { return json({ error: 'Kho phiên đăng nhập tạm thời không khả dụng.' }, 503); }
    const t = now();
    if (path === '/auth/email/start') {
      try {
        const row = await env.DB.prepare('SELECT sent_at, window_start, sent_count FROM auth_otp_codes WHERE email = ?').bind(email).first();
        if (row && t - Number(row.sent_at) < OTP_RESEND_AFTER) {
          const wait = OTP_RESEND_AFTER - (t - Number(row.sent_at));
          return json({ error: `Vui lòng chờ ${wait} giây trước khi gửi lại mã.`, retryAfter: wait }, 429, { 'Retry-After': String(wait) });
        }
        const sameWindow = row && t - Number(row.window_start) < 3600;
        const windowStart = sameWindow ? Number(row.window_start) : t;
        const count = sameWindow ? Number(row.sent_count) : 0;
        if (count >= OTP_MAX_PER_HOUR) {
          const wait = windowStart + 3600 - t;
          return json({ error: 'Đã gửi quá nhiều mã cho email này. Vui lòng thử lại sau ' + Math.ceil(wait / 60) + ' phút.', retryAfter: wait }, 429, { 'Retry-After': String(wait) });
        }
        const code = otpCode(), salt = randomToken(16);
        await env.DB.prepare('INSERT INTO auth_otp_codes (email, code_hash, salt, expires_at, attempts, sent_at, window_start, sent_count) VALUES (?, ?, ?, ?, 0, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, salt = excluded.salt, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at, window_start = excluded.window_start, sent_count = excluded.sent_count')
          .bind(email, await hashHex(salt + ':' + email + ':' + code), salt, t + OTP_TTL, t, windowStart, count + 1).run();
        let sent = false;
        try {
          const response = await fetch(RESEND_API, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { Authorization: 'Bearer ' + clean(env.RESEND_API_KEY), 'Content-Type': 'application/json' }, body: JSON.stringify({
            from: clean(env.EMAIL_FROM), to: [email], subject: 'Mã đăng nhập ShopAI của bạn',
            text: `Mã đăng nhập ShopAI của bạn là ${code}. Mã có hiệu lực trong 10 phút và chỉ dùng được một lần. Nếu bạn không yêu cầu đăng nhập, hãy bỏ qua email này.`,
            html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#0a0a0a"><p>Mã đăng nhập ShopAI của bạn là:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>Mã có hiệu lực trong 10 phút và chỉ dùng được một lần.</p><p style="color:#717182">Nếu bạn không yêu cầu đăng nhập, hãy bỏ qua email này.</p></div>`
          }) });
          sent = response.ok;
        } catch { sent = false; }
        if (!sent) {
          await env.DB.prepare("UPDATE auth_otp_codes SET code_hash = '' WHERE email = ?").bind(email).run();
          return json({ error: 'Không gửi được email lúc này. Vui lòng thử lại sau ít phút.' }, 502);
        }
        return json({ ok: true, retryAfter: OTP_RESEND_AFTER, expiresIn: OTP_TTL });
      } catch { return json({ error: 'Không thể tạo mã đăng nhập lúc này.' }, 503); }
    }
    // /auth/email/verify
    const code = body.code;
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return json({ error: 'Mã gồm đúng 6 chữ số.' }, 400);
    try {
      const row = await env.DB.prepare('SELECT code_hash, salt, expires_at, attempts FROM auth_otp_codes WHERE email = ?').bind(email).first();
      if (!row || !row.code_hash || Number(row.expires_at) <= t) return json({ error: 'Mã đã hết hạn hoặc chưa được gửi. Vui lòng gửi mã mới.' }, 400);
      if (Number(row.attempts) >= OTP_MAX_ATTEMPTS) return json({ error: 'Bạn đã nhập sai quá 5 lần. Vui lòng gửi mã mới.' }, 429);
      // Giữ chỗ một lượt thử một cách nguyên tử trước khi so sánh, tránh đoán song song vượt giới hạn.
      const reserved = await env.DB.prepare("UPDATE auth_otp_codes SET attempts = attempts + 1 WHERE email = ? AND code_hash = ? AND attempts < ? AND expires_at > ?").bind(email, row.code_hash, OTP_MAX_ATTEMPTS, t).run();
      if (!reserved?.meta?.changes) return json({ error: 'Mã đã hết hạn hoặc đã bị khóa. Vui lòng gửi mã mới.' }, 429);
      if (!sameText(await hashHex(row.salt + ':' + email + ':' + code), row.code_hash)) {
        const left = OTP_MAX_ATTEMPTS - Number(row.attempts) - 1;
        if (left <= 0) {
          await env.DB.prepare("UPDATE auth_otp_codes SET code_hash = '' WHERE email = ?").bind(email).run();
          return json({ error: 'Bạn đã nhập sai quá 5 lần. Vui lòng gửi mã mới.' }, 429);
        }
        return json({ error: `Mã không đúng. Bạn còn ${left} lần thử.`, attemptsLeft: left }, 400);
      }
      const used = await env.DB.prepare('DELETE FROM auth_otp_codes WHERE email = ? AND code_hash = ?').bind(email, row.code_hash).run();
      if (!used?.meta?.changes) return json({ error: 'Mã đã được sử dụng. Vui lòng gửi mã mới.' }, 400);
      const cookie = await createSession(env, 'email:' + email, 'email', email);
      return respond({ ok: true, provider: 'email', name: email }, 200, [cookie]);
    } catch { return json({ error: 'Không thể xác minh mã lúc này.' }, 503); }
  }

  // Zalo OAuth v4 + PKCE (điều hướng toàn trang, không cần Origin).
  if (path === '/auth/zalo/start') {
    if (!available.zalo.enabled) return redirect('/?loi=zalo_chua_cau_hinh');
    try {
      await ensureSchema(env.DB);
      const state = randomToken(24), verifier = pkceVerifier(), t = now();
      await env.DB.batch([
        env.DB.prepare('DELETE FROM auth_oauth_states WHERE expires_at <= ?').bind(t),
        env.DB.prepare('INSERT INTO auth_oauth_states (state, provider, verifier, expires_at) VALUES (?, ?, ?, ?)').bind(state, 'zalo', verifier, t + STATE_TTL)
      ]);
      const target = ZALO_AUTHORIZE + '?' + new URLSearchParams({ app_id: clean(env.ZALO_APP_ID), redirect_uri: url.origin + '/auth/zalo/callback', code_challenge: await pkceChallenge(verifier), state });
      return redirect(target, [setCookie(STATE_COOKIE, state, STATE_TTL)]);
    } catch { return redirect('/?loi=zalo_tam_loi'); }
  }
  // /auth/zalo/callback
  const clearState = setCookie(STATE_COOKIE, '', 0);
  const fail = code => redirect('/?loi=' + code, [clearState]);
  if (!available.zalo.enabled) return fail('zalo_chua_cau_hinh');
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || url.searchParams.get('oauth_code') || '';
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(state) || !sameText(readCookie(request, STATE_COOKIE) || '', state)) return fail('zalo_state');
  try {
    await ensureSchema(env.DB);
    const row = await env.DB.prepare('SELECT verifier, expires_at FROM auth_oauth_states WHERE state = ? AND provider = ?').bind(state, 'zalo').first();
    const consumed = row ? await env.DB.prepare('DELETE FROM auth_oauth_states WHERE state = ?').bind(state).run() : null;
    if (!row || !consumed?.meta?.changes || Number(row.expires_at) <= now()) return fail('zalo_het_han');
    if (!code || code.length > 2048) return fail('zalo_tu_choi');
    const token = await fetchJson(ZALO_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', secret_key: clean(env.ZALO_APP_SECRET) }, body: new URLSearchParams({ app_id: clean(env.ZALO_APP_ID), code, code_verifier: row.verifier, grant_type: 'authorization_code' }).toString() });
    const accessToken = token.data && token.data.access_token;
    if (!token.ok || typeof accessToken !== 'string' || !accessToken) return fail('zalo_token');
    const profile = await fetchJson(ZALO_PROFILE, { headers: { access_token: accessToken } });
    const id = profile.data && String(profile.data.id);
    if (!profile.ok || !profile.data || (profile.data.error && Number(profile.data.error) !== 0) || !/^\d{1,32}$/.test(id || '')) return fail('zalo_ho_so');
    const cookie = await createSession(env, 'zalo:' + id, 'zalo', displayName(profile.data.name));
    return redirect('/', [cookie, clearState]);
  } catch { return fail('zalo_tam_loi'); }
}
