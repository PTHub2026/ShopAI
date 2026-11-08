// Đăng nhập bằng phiên riêng của ShopPost (Zalo, Facebook, TikTok, số điện thoại OTP, email OTP), chạy song song với Cloudflare Access.
// Tên cookie/bảng giữ tiền tố "shopai" vì là định danh kỹ thuật: đổi sẽ làm mất phiên và dữ liệu đang có.
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
const TIKTOK_AUTHORIZE = 'https://www.tiktok.com/v2/auth/authorize/';
const TIKTOK_TOKEN = 'https://open.tiktokapis.com/v2/oauth/token/';
const TIKTOK_USER = 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,display_name,avatar_url';
const ESMS_API = 'https://rest.esms.vn/MainService.svc/json/SendMultipleMessage_V4_post_json/';
const TWILIO_VERIFY = 'https://verify.twilio.com/v2/Services/';
// Với Twilio Verify, Twilio tự sinh/kiểm mã nên hàng OTP chỉ giữ dấu này (không phải hash) để áp giới hạn phía Worker.
const TWILIO_MARK = 'twilio-verify';
const PHONE_INVALID = 'Số điện thoại không hợp lệ. Vui lòng nhập số di động Việt Nam, ví dụ 0912 345 678 hoặc +84 912 345 678.';
// Giữ đồng bộ với backend/migrations/0002_auth.sql (kiểm thử so khớp hai nơi).
// Bảng auth_otp_codes dùng chung cho email và số điện thoại: cột "email" chứa đích nhận mã (email hoặc số E.164 "+84…"),
// giữ nguyên tên cột để tương thích ngược, không cần migration mới.
export const AUTH_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS auth_identities (owner TEXT PRIMARY KEY, provider TEXT NOT NULL, display_name TEXT, created_at INTEGER NOT NULL, last_login_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, owner TEXT NOT NULL, provider TEXT NOT NULL, display_name TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS auth_sessions_expires ON auth_sessions(expires_at)',
  'CREATE TABLE IF NOT EXISTS auth_otp_codes (email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, salt TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL, window_start INTEGER NOT NULL, sent_count INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS auth_oauth_states (state TEXT PRIMARY KEY, provider TEXT NOT NULL, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL)'
];
const FALLBACK_LOGIN = '<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Đăng nhập ShopPost</title></head><body><main><h1>ShopPost</h1><p>Vui lòng đăng nhập để tiếp tục. Trang đăng nhập đang được cập nhật, hãy tải lại sau ít phút.</p></main></body></html>';

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
// TikTok Login Kit lệch RFC 7636: code_challenge là SHA-256 dạng hex chữ thường của code_verifier.
export const tiktokChallenge = async verifier => hashHex(verifier);
// Chuẩn hóa số di động Việt Nam về E.164: 0912345678 / 84912345678 / +84912345678 → +84912345678.
export function normalizePhone(value) {
  if (typeof value !== 'string' || value.length > 32) return null;
  let digits = value.trim().replace(/[\s.()-]/g, '');
  if (digits.startsWith('+84')) digits = digits.slice(3).replace(/^0(?=\d{9}$)/, '');
  else if (digits.startsWith('0')) digits = digits.slice(1);
  else if (digits.startsWith('84') && digits.length === 11) digits = digits.slice(2);
  else return null;
  return /^[35789]\d{8}$/.test(digits) ? '+84' + digits : null;
}
// Adapter SMS: eSMS.vn được ưu tiên nếu đủ cấu hình, sau đó tới Twilio Verify; không có thì tắt đăng nhập bằng số điện thoại.
function smsProvider(env) {
  if (clean(env.ESMS_API_KEY) && clean(env.ESMS_SECRET_KEY) && /^[A-Za-z0-9 ._-]{2,20}$/.test(clean(env.ESMS_BRANDNAME))) return 'esms';
  if (/^AC[0-9a-f]{32}$/i.test(clean(env.TWILIO_ACCOUNT_SID)) && clean(env.TWILIO_AUTH_TOKEN) && /^VA[0-9a-f]{32}$/i.test(clean(env.TWILIO_VERIFY_SERVICE_SID))) return 'twilio';
  return null;
}
const twilioAuth = env => 'Basic ' + btoa(clean(env.TWILIO_ACCOUNT_SID) + ':' + clean(env.TWILIO_AUTH_TOKEN));
const twilioUrl = (env, action) => TWILIO_VERIFY + encodeURIComponent(clean(env.TWILIO_VERIFY_SERVICE_SID)) + '/' + action;
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
export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254) return null;
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(email) ? email : null;
}
// EMAIL_FROM dạng "ShopPost <no-reply@shoppost.net>" hoặc "no-reply@shoppost.net" → { email, name? }; sai định dạng → null.
export function parseEmailFrom(value) {
  const v = clean(value);
  if (v.length < 3 || v.length > 200 || /[\r\n]/.test(v)) return null;
  const match = v.match(/^(?:"?([^"<>]*?)"?\s*)?<([^<>\s]+)>$/);
  const email = normalizeEmail(match ? match[2] : v);
  if (!email) return null;
  const name = match ? displayName(match[1] || '') : '';
  return name ? { email, name } : { email };
}
// Adapter email: ưu tiên binding Cloudflare Email Service (env.EMAIL), dự phòng Resend; thiếu EMAIL_FROM hợp lệ thì tắt email.
function emailProvider(env) {
  if (!parseEmailFrom(env.EMAIL_FROM)) return null;
  if (env.EMAIL && typeof env.EMAIL.send === 'function') return 'cloudflare';
  if (clean(env.RESEND_API_KEY)) return 'resend';
  return null;
}
export const emailConfigured = env => Boolean(emailProvider(env));
// Trả true/false; không bao giờ ném lỗi ra ngoài và không đưa chi tiết lỗi nội bộ cho client, chỉ ghi mã lỗi vào log máy chủ.
export async function sendEmail(env, { to, subject, html, text }) {
  const provider = emailProvider(env);
  if (!provider) return false;
  try {
    if (provider === 'cloudflare') {
      await env.EMAIL.send({ to, from: parseEmailFrom(env.EMAIL_FROM), subject, html, text });
      return true;
    }
    const response = await fetch(RESEND_API, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { Authorization: 'Bearer ' + clean(env.RESEND_API_KEY), 'Content-Type': 'application/json' }, body: JSON.stringify({ from: clean(env.EMAIL_FROM), to: [to], subject, text, html }) });
    if (!response.ok) console.error('email_send_failed', JSON.stringify({ provider, code: 'http_' + response.status }));
    return response.ok;
  } catch (error) {
    const code = error && typeof error.code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(error.code) ? error.code : (error && error.name === 'TimeoutError' ? 'timeout' : 'unknown');
    console.error('email_send_failed', JSON.stringify({ provider, code }));
    return false;
  }
}
const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
// Khung email chung (tiếng Việt, có bản html và text).
export function emailLayout(paragraphs, highlight = '') {
  const body = paragraphs.map(p => `<p style="margin:0 0 12px">${escapeHtml(p)}</p>`);
  if (highlight) body.splice(1, 0, `<p style="margin:0 0 12px;font-size:28px;font-weight:700;letter-spacing:6px">${escapeHtml(highlight)}</p>`);
  return `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"></head><body style="margin:0;padding:24px;background:#f6f6f8"><div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#0a0a0a"><p style="margin:0 0 16px;font-weight:700;font-size:18px">ShopPost</p>${body.join('')}</div></body></html>`;
}
export function otpEmail(code) {
  const minutes = Math.round(OTP_TTL / 60);
  const ignore = 'Nếu bạn không yêu cầu, hãy bỏ qua email này.';
  return {
    subject: 'Mã đăng nhập ShopPost của bạn',
    text: `Mã đăng nhập ShopPost của bạn là ${code}.\n\nMã có hiệu lực trong ${minutes} phút và chỉ dùng được một lần. Không chia sẻ mã này với bất kỳ ai.\n\n${ignore}\n\nShopPost – https://shoppost.net`,
    html: emailLayout(['Mã đăng nhập ShopPost của bạn là:', `Mã có hiệu lực trong ${minutes} phút và chỉ dùng được một lần. Không chia sẻ mã này với bất kỳ ai.`, ignore], code)
  };
}

export function providers(env) {
  const db = Boolean(env.DB);
  const facebookId = clean(env.FACEBOOK_APP_ID), zaloId = clean(env.ZALO_APP_ID);
  const team = clean(env.ACCESS_TEAM_DOMAIN);
  const facebook = db && /^\d{5,20}$/.test(facebookId);
  const zalo = db && /^\d{5,25}$/.test(zaloId) && Boolean(clean(env.ZALO_APP_SECRET));
  const email = db && emailConfigured(env);
  const tiktok = db && /^[A-Za-z0-9_-]{4,64}$/.test(clean(env.TIKTOK_CLIENT_KEY)) && Boolean(clean(env.TIKTOK_CLIENT_SECRET));
  const phone = db && Boolean(smsProvider(env));
  return {
    facebook: facebook ? { enabled: true, appId: facebookId } : { enabled: false },
    zalo: { enabled: zalo },
    tiktok: { enabled: tiktok },
    phone: { enabled: phone },
    email: { enabled: email },
    access: /^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(team) ? { url: 'https://' + team } : null,
    ready: facebook || zalo || tiktok || phone || email
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

// eSMS.vn: tin chăm sóc khách hàng có brandname (SmsType 2); nội dung phải khớp mẫu đã đăng ký với eSMS.
// Twilio Verify: Twilio tự sinh và gửi mã (code = null).
async function sendSmsCode(env, provider, phone, code) {
  if (provider === 'esms') {
    const result = await fetchJson(ESMS_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      ApiKey: clean(env.ESMS_API_KEY), SecretKey: clean(env.ESMS_SECRET_KEY), Brandname: clean(env.ESMS_BRANDNAME),
      Phone: '0' + phone.slice(3), SmsType: '2', IsUnicode: '1', Sandbox: '0', RequestId: randomToken(18),
      Content: `Mã đăng nhập ShopPost của bạn là ${code}. Hiệu lực 10 phút. Không chia sẻ mã này.`
    }) });
    return result.ok && String(result.data?.CodeResult) === '100';
  }
  const result = await fetchJson(twilioUrl(env, 'Verifications'), { method: 'POST', headers: { Authorization: twilioAuth(env), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ To: phone, Channel: 'sms' }).toString() });
  return result.ok && result.data?.status === 'pending';
}

// Kết quả: 'approved' (đúng), 'wrong' (sai mã), 'expired' (Twilio không còn lượt xác minh: hết hạn, đã dùng hoặc quá số lần).
async function twilioCheck(env, phone, code) {
  const result = await fetchJson(twilioUrl(env, 'VerificationCheck'), { method: 'POST', headers: { Authorization: twilioAuth(env), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ To: phone, Code: code }).toString() });
  if (result.status === 404 || result.status === 429) return 'expired';
  if (!result.ok) throw new Error('TWILIO_UNAVAILABLE');
  return result.data?.status === 'approved' ? 'approved' : 'wrong';
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
    '/auth/providers': 'GET', '/auth/zalo/start': 'GET', '/auth/zalo/callback': 'GET', '/auth/tiktok/start': 'GET', '/auth/tiktok/callback': 'GET',
    '/auth/facebook': 'POST', '/auth/phone/start': 'POST', '/auth/phone/verify': 'POST', '/auth/email/start': 'POST', '/auth/email/verify': 'POST', '/auth/logout': 'POST'
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
        if (!app.ok || !app.data || String(app.data.id) !== available.facebook.appId) return json({ error: 'Phiên Facebook không thuộc ứng dụng ShopPost. Vui lòng đăng nhập lại.' }, 401);
        const me = await fetchJson(FB_API + '/me?fields=id,name&access_token=' + encodeURIComponent(token));
        const id = me.data && String(me.data.id);
        if (!me.ok || !/^\d{1,32}$/.test(id || '')) return json({ error: 'Không đọc được hồ sơ Facebook.' }, 401);
        const name = displayName(me.data.name);
        const cookie = await createSession(env, 'fb:' + id, 'facebook', name);
        return respond({ ok: true, provider: 'facebook', name }, 200, [cookie]);
      } catch { return json({ error: 'Không kết nối được Facebook lúc này. Vui lòng thử lại.' }, 502); }
    }

    // OTP qua email hoặc số điện thoại (SMS): cùng giới hạn gửi lại 60 giây, 5 mã/giờ, 5 lần sai, mã hiệu lực 10 phút.
    const viaPhone = path.startsWith('/auth/phone/');
    const sms = viaPhone ? smsProvider(env) : null;
    if (viaPhone && !available.phone.enabled) return json({ error: 'Đăng nhập bằng số điện thoại chưa được kích hoạt.' }, 503);
    if (!viaPhone && !available.email.enabled) return json({ error: 'Đăng nhập bằng email chưa được kích hoạt.' }, 503);
    const email = viaPhone ? normalizePhone(body.phone) : normalizeEmail(body.email); // đích nhận mã: email hoặc số E.164
    if (!email) return json({ error: viaPhone ? PHONE_INVALID : 'Địa chỉ email không hợp lệ.' }, 400);
    try { await ensureSchema(env.DB); } catch { return json({ error: 'Kho phiên đăng nhập tạm thời không khả dụng.' }, 503); }
    const t = now();
    if (path.endsWith('/start')) {
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
          return json({ error: `Đã gửi quá nhiều mã cho ${viaPhone ? 'số điện thoại' : 'email'} này. Vui lòng thử lại sau ` + Math.ceil(wait / 60) + ' phút.', retryAfter: wait }, 429, { 'Retry-After': String(wait) });
        }
        const code = sms === 'twilio' ? null : otpCode(), salt = randomToken(16);
        await env.DB.prepare('INSERT INTO auth_otp_codes (email, code_hash, salt, expires_at, attempts, sent_at, window_start, sent_count) VALUES (?, ?, ?, ?, 0, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, salt = excluded.salt, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at, window_start = excluded.window_start, sent_count = excluded.sent_count')
          .bind(email, code ? await hashHex(salt + ':' + email + ':' + code) : TWILIO_MARK, salt, t + OTP_TTL, t, windowStart, count + 1).run();
        let sent = false;
        try { sent = viaPhone ? await sendSmsCode(env, sms, email, code) : await sendEmail(env, { to: email, ...otpEmail(code) }); } catch { sent = false; }
        if (!sent) {
          await env.DB.prepare("UPDATE auth_otp_codes SET code_hash = '' WHERE email = ?").bind(email).run();
          return json({ error: viaPhone ? 'Không gửi được tin nhắn SMS lúc này. Vui lòng thử lại sau ít phút.' : 'Không gửi được email lúc này. Vui lòng thử lại sau ít phút.' }, 502);
        }
        return json({ ok: true, retryAfter: OTP_RESEND_AFTER, expiresIn: OTP_TTL });
      } catch { return json({ error: 'Không thể tạo mã đăng nhập lúc này.' }, 503); }
    }
    // /auth/email/verify hoặc /auth/phone/verify
    const code = body.code;
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return json({ error: 'Mã gồm đúng 6 chữ số.' }, 400);
    try {
      const row = await env.DB.prepare('SELECT code_hash, salt, expires_at, attempts FROM auth_otp_codes WHERE email = ?').bind(email).first();
      if (!row || !row.code_hash || Number(row.expires_at) <= t) return json({ error: 'Mã đã hết hạn hoặc chưa được gửi. Vui lòng gửi mã mới.' }, 400);
      if (Number(row.attempts) >= OTP_MAX_ATTEMPTS) return json({ error: 'Bạn đã nhập sai quá 5 lần. Vui lòng gửi mã mới.' }, 429);
      // Giữ chỗ một lượt thử một cách nguyên tử trước khi so sánh, tránh đoán song song vượt giới hạn.
      const reserved = await env.DB.prepare("UPDATE auth_otp_codes SET attempts = attempts + 1 WHERE email = ? AND code_hash = ? AND attempts < ? AND expires_at > ?").bind(email, row.code_hash, OTP_MAX_ATTEMPTS, t).run();
      if (!reserved?.meta?.changes) return json({ error: 'Mã đã hết hạn hoặc đã bị khóa. Vui lòng gửi mã mới.' }, 429);
      let valid;
      if (sms === 'twilio' && row.code_hash === TWILIO_MARK) {
        const check = await twilioCheck(env, email, code);
        if (check === 'expired') {
          await env.DB.prepare("UPDATE auth_otp_codes SET code_hash = '' WHERE email = ?").bind(email).run();
          return json({ error: 'Mã đã hết hạn hoặc chưa được gửi. Vui lòng gửi mã mới.' }, 400);
        }
        valid = check === 'approved';
      } else valid = row.code_hash !== TWILIO_MARK && sameText(await hashHex(row.salt + ':' + email + ':' + code), row.code_hash);
      if (!valid) {
        const left = OTP_MAX_ATTEMPTS - Number(row.attempts) - 1;
        if (left <= 0) {
          await env.DB.prepare("UPDATE auth_otp_codes SET code_hash = '' WHERE email = ?").bind(email).run();
          return json({ error: 'Bạn đã nhập sai quá 5 lần. Vui lòng gửi mã mới.' }, 429);
        }
        return json({ error: `Mã không đúng. Bạn còn ${left} lần thử.`, attemptsLeft: left }, 400);
      }
      const used = await env.DB.prepare('DELETE FROM auth_otp_codes WHERE email = ? AND code_hash = ?').bind(email, row.code_hash).run();
      if (!used?.meta?.changes) return json({ error: 'Mã đã được sử dụng. Vui lòng gửi mã mới.' }, 400);
      const provider = viaPhone ? 'phone' : 'email';
      const cookie = await createSession(env, provider + ':' + email, provider, email);
      return respond({ ok: true, provider, name: email }, 200, [cookie]);
    } catch { return json({ error: 'Không thể xác minh mã lúc này.' }, 503); }
  }

  // OAuth điều hướng toàn trang, không cần Origin: Zalo OAuth v4 + PKCE và TikTok Login Kit + PKCE.
  const provider = path.split('/')[2]; // 'zalo' | 'tiktok'
  const callbackUrl = url.origin + '/auth/' + provider + '/callback';
  if (path.endsWith('/start')) {
    if (!available[provider].enabled) return redirect(`/?loi=${provider}_chua_cau_hinh`);
    try {
      await ensureSchema(env.DB);
      const state = randomToken(24), verifier = pkceVerifier(), t = now();
      await env.DB.batch([
        env.DB.prepare('DELETE FROM auth_oauth_states WHERE expires_at <= ?').bind(t),
        env.DB.prepare('INSERT INTO auth_oauth_states (state, provider, verifier, expires_at) VALUES (?, ?, ?, ?)').bind(state, provider, verifier, t + STATE_TTL)
      ]);
      const target = provider === 'zalo'
        ? ZALO_AUTHORIZE + '?' + new URLSearchParams({ app_id: clean(env.ZALO_APP_ID), redirect_uri: callbackUrl, code_challenge: await pkceChallenge(verifier), state })
        : TIKTOK_AUTHORIZE + '?' + new URLSearchParams({ client_key: clean(env.TIKTOK_CLIENT_KEY), scope: 'user.info.basic', response_type: 'code', redirect_uri: callbackUrl, state, code_challenge: await tiktokChallenge(verifier), code_challenge_method: 'S256' });
      return redirect(target, [setCookie(STATE_COOKIE, state, STATE_TTL)]);
    } catch { return redirect(`/?loi=${provider}_tam_loi`); }
  }
  // /auth/zalo/callback hoặc /auth/tiktok/callback
  const clearState = setCookie(STATE_COOKIE, '', 0);
  const fail = code => redirect(`/?loi=${provider}_${code}`, [clearState]);
  if (!available[provider].enabled) return fail('chua_cau_hinh');
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || (provider === 'zalo' ? url.searchParams.get('oauth_code') : '') || '';
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(state) || !sameText(readCookie(request, STATE_COOKIE) || '', state)) return fail('state');
  try {
    await ensureSchema(env.DB);
    const row = await env.DB.prepare('SELECT verifier, expires_at FROM auth_oauth_states WHERE state = ? AND provider = ?').bind(state, provider).first();
    const consumed = row ? await env.DB.prepare('DELETE FROM auth_oauth_states WHERE state = ?').bind(state).run() : null;
    if (!row || !consumed?.meta?.changes || Number(row.expires_at) <= now()) return fail('het_han');
    if (!code || code.length > 2048 || (provider === 'tiktok' && url.searchParams.has('error'))) return fail('tu_choi');
    if (provider === 'zalo') {
      const token = await fetchJson(ZALO_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', secret_key: clean(env.ZALO_APP_SECRET) }, body: new URLSearchParams({ app_id: clean(env.ZALO_APP_ID), code, code_verifier: row.verifier, grant_type: 'authorization_code' }).toString() });
      const accessToken = token.data && token.data.access_token;
      if (!token.ok || typeof accessToken !== 'string' || !accessToken) return fail('token');
      const profile = await fetchJson(ZALO_PROFILE, { headers: { access_token: accessToken } });
      const id = profile.data && String(profile.data.id);
      if (!profile.ok || !profile.data || (profile.data.error && Number(profile.data.error) !== 0) || !/^\d{1,32}$/.test(id || '')) return fail('ho_so');
      const cookie = await createSession(env, 'zalo:' + id, 'zalo', displayName(profile.data.name));
      return redirect('/', [cookie, clearState]);
    }
    // TikTok: đổi code lấy access token (kèm code_verifier), rồi đọc open_id/display_name.
    const token = await fetchJson(TIKTOK_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_key: clean(env.TIKTOK_CLIENT_KEY), client_secret: clean(env.TIKTOK_CLIENT_SECRET), code, grant_type: 'authorization_code', redirect_uri: callbackUrl, code_verifier: row.verifier }).toString() });
    const accessToken = token.data && token.data.access_token;
    if (!token.ok || (token.data && token.data.error) || typeof accessToken !== 'string' || !accessToken) return fail('token');
    const profile = await fetchJson(TIKTOK_USER, { headers: { Authorization: 'Bearer ' + accessToken } });
    const user = profile.data && profile.data.data && profile.data.data.user;
    const errorCode = profile.data && profile.data.error && profile.data.error.code;
    const id = user && typeof user.open_id === 'string' ? user.open_id : '';
    if (!profile.ok || (errorCode && errorCode !== 'ok') || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) return fail('ho_so');
    const cookie = await createSession(env, 'tiktok:' + id, 'tiktok', displayName(user.display_name));
    return redirect('/', [cookie, clearState]);
  } catch { return fail('tam_loi'); }
}
