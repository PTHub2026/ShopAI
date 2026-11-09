// Kết nối kênh thật cho shop. Hiện triển khai Zalo OA (OAuth v4 + PKCE) và đăng bài viết thật.
// Các kênh khác (Facebook, TikTok, YouTube, Instagram, Telegram, X, LinkedIn, Threads) vẫn ở chế độ demo trên giao diện.
// Token (access/refresh) chỉ lưu trong D1, KHÔNG BAO GIỜ trả ra giao diện.
import { resolveShop, SHOP_HEADER } from './shops.js';
import { pkceVerifier, pkceChallenge, readJson } from './auth.js';

const CONNECT_COOKIE = '__Host-shopai_zconnect';
const CONNECT_TTL = 600; // 10 phút: đủ cho một lượt cấp quyền OA.
const REFRESH_SKEW = 300; // làm mới access_token khi còn dưới 5 phút là hết hạn.

// Điểm cuối Zalo OA (OAuth v4). app_id là biến thường, app_secret là secret của Worker.
const ZALO_PERMISSION = 'https://oauth.zaloapp.com/v4/oa/permission';
const ZALO_TOKEN = 'https://oauth.zaloapp.com/v4/oa/access_token';
const ZALO_GETOA = 'https://openapi.zalo.me/v2.0/oa/getoa';
const ZALO_ARTICLE_CREATE = 'https://openapi.zalo.me/v3.0/article/create';
const ZALO_ARTICLE_VERIFY = 'https://openapi.zalo.me/v3.0/article/verify';

const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlStr = text => b64url(enc.encode(text));
const fromB64url = s => { const t = s.replace(/-/g, '+').replace(/_/g, '/'); return atob(t + '='.repeat((4 - t.length % 4) % 4)); };
const randToken = (size = 18) => b64url(crypto.getRandomValues(new Uint8Array(size)));
const clean = v => typeof v === 'string' ? v.trim() : '';

const setCookie = (name, value, maxAge) => `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
const clearCookie = name => `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
function readCookie(request, name) {
  const m = ('; ' + (request.headers.get('Cookie') || '')).match(new RegExp('; ' + name.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&') + '=([^;]*)'));
  return m ? m[1] : null;
}
function redirectTo(location, cookies = []) {
  const h = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const c of cookies) h.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers: h });
}

// Cookie phiên kết nối được ký HMAC bằng khóa dẫn xuất từ ZALO_APP_SECRET: chống giả mạo verifier/state/shop_id/user.
async function signKey(env) {
  return crypto.subtle.importKey('raw', enc.encode('zconnect:' + String(env.ZALO_APP_SECRET || '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function sealCookie(env, data) {
  const payload = b64urlStr(JSON.stringify(data));
  const sig = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', await signKey(env), enc.encode(payload))));
  return payload + '.' + sig;
}
async function openCookie(env, value) {
  if (typeof value !== 'string' || !value.includes('.')) return null;
  const idx = value.indexOf('.');
  const payload = value.slice(0, idx), sig = value.slice(idx + 1);
  try {
    const ok = await crypto.subtle.verify('HMAC', await signKey(env), Uint8Array.from(fromB64url(sig), c => c.charCodeAt(0)), enc.encode(payload));
    if (!ok) return null;
    const data = JSON.parse(fromB64url(payload));
    if (!data || typeof data !== 'object' || !Number.isFinite(data.exp) || data.exp <= now()) return null;
    return data;
  } catch { return null; }
}

// Schema tạo lúc chạy (idempotent) vì Workers Builds không chạy migration tự động.
const CHANNELS_SCHEMA = 'CREATE TABLE IF NOT EXISTS shop_channels (shop_id TEXT NOT NULL, provider TEXT NOT NULL, external_id TEXT, name TEXT, access_token TEXT, refresh_token TEXT, expires_at INTEGER, status TEXT, connected_by TEXT, connected_at INTEGER, updated_at INTEGER, PRIMARY KEY (shop_id, provider))';
const schemaReady = new WeakSet();
async function ensureChannelsSchema(db) {
  if (schemaReady.has(db)) return;
  await db.prepare(CHANNELS_SCHEMA).run();
  schemaReady.add(db);
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(10000) });
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  return { ok: response.ok, status: response.status, data };
}

// Thông điệp lỗi từ Zalo để hiển thị lại cho người dùng (tiếng Việt bao ngoài).
function zaloError(result) {
  const d = result && result.data;
  if (!d) return 'Zalo không phản hồi (HTTP ' + (result ? result.status : '?') + ').';
  const msg = clean(d.message) || clean(d.error_name) || clean(d.error_reason);
  if (msg) return msg;
  if (d.error !== undefined && Number(d.error) !== 0) return 'mã lỗi ' + d.error;
  return 'lỗi không xác định.';
}

async function exchangeToken(env, { code, verifier, redirectUri }) {
  const body = new URLSearchParams({ app_id: String(env.ZALO_APP_ID || ''), grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri });
  return fetchJson(ZALO_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', secret_key: String(env.ZALO_APP_SECRET || '') }, body: body.toString() });
}
async function refreshAccessToken(env, refreshToken) {
  const body = new URLSearchParams({ app_id: String(env.ZALO_APP_ID || ''), grant_type: 'refresh_token', refresh_token: refreshToken });
  return fetchJson(ZALO_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', secret_key: String(env.ZALO_APP_SECRET || '') }, body: body.toString() });
}
async function getOaInfo(accessToken) {
  return fetchJson(ZALO_GETOA, { method: 'GET', headers: { access_token: accessToken } });
}

async function upsertChannel(db, { shopId, provider, externalId, name, accessToken, refreshToken, expiresAt, connectedBy }) {
  const t = now();
  await db.prepare(
    'INSERT INTO shop_channels (shop_id, provider, external_id, name, access_token, refresh_token, expires_at, status, connected_by, connected_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(shop_id, provider) DO UPDATE SET external_id = excluded.external_id, name = excluded.name, access_token = excluded.access_token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, status = excluded.status, connected_by = excluded.connected_by, connected_at = excluded.connected_at, updated_at = excluded.updated_at'
  ).bind(shopId, provider, externalId, name, accessToken, refreshToken, expiresAt, 'connected', connectedBy, t, t).run();
}
async function persistTokens(db, shopId, provider, { accessToken, refreshToken, expiresAt }) {
  await db.prepare('UPDATE shop_channels SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = ? WHERE shop_id = ? AND provider = ?')
    .bind(accessToken, refreshToken, expiresAt, now(), shopId, provider).run();
}

// Làm mới access_token nếu sắp/đã hết hạn và lưu lại cặp token mới (refresh_token Zalo dùng một lần, phải lưu cái mới trả về).
async function ensureFreshToken(env, db, channel) {
  if (channel.expires_at && Number(channel.expires_at) - now() > REFRESH_SKEW) return { token: channel.access_token };
  if (!channel.refresh_token) return { token: channel.access_token };
  const r = await refreshAccessToken(env, channel.refresh_token);
  if (r.ok && r.data && r.data.access_token) {
    const accessToken = r.data.access_token;
    const refreshToken = r.data.refresh_token || channel.refresh_token;
    const expiresAt = now() + (Number(r.data.expires_in) || 90000);
    await persistTokens(db, channel.shop_id, channel.provider, { accessToken, refreshToken, expiresAt });
    return { token: accessToken };
  }
  // Làm mới thất bại: dùng tạm token hiện có, lỗi (nếu có) sẽ lộ ra khi gọi API đăng bài.
  return { token: channel.access_token, refreshFailed: true, detail: zaloError(r) };
}

// Ngữ cảnh shop: connect là điều hướng cấp trang (không có header shop) nên nhận shop qua ?shop=; list/publish là fetch nên dùng header.
async function shopCtx(env, who, request, shopId) {
  if (shopId) return resolveShop(env, who, new Request(request.url, { headers: { [SHOP_HEADER]: shopId } }));
  return resolveShop(env, who, request);
}

// Router /channels/* — gọi sau khi worker đã xác thực danh tính + kiểm tra cùng origin + có DB.
export async function channels(request, env, who, json) {
  await ensureChannelsSchema(env.DB);
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Danh sách kênh của shop — KHÔNG trả access_token/refresh_token.
  if (path === '/channels') {
    if (method !== 'GET') return json({ error: 'Chỉ hỗ trợ GET.' }, 405, { Allow: 'GET' });
    let ctx;
    try { ctx = await resolveShop(env, who, request); } catch { return json({ error: 'Không thể truy cập ngữ cảnh shop lúc này.' }, 503); }
    if (ctx.error) return json({ error: ctx.error, code: ctx.code }, ctx.status);
    if (!ctx.can('channels.view')) return json({ error: 'Vai trò của bạn trong shop này không được xem kênh.', code: 'forbidden' }, 403);
    const { results } = await env.DB.prepare('SELECT provider, external_id, name, status, connected_at FROM shop_channels WHERE shop_id = ?').bind(ctx.shop.id).all();
    const list = (results || []).map(r => ({ provider: r.provider, external_id: r.external_id, oa_id: r.external_id, name: r.name, status: r.status, connected_at: Number(r.connected_at) || null }));
    return json({ channels: list });
  }

  // Bắt đầu kết nối Zalo OA: sinh PKCE + state, lưu vào cookie ký HMAC rồi 302 sang trang cấp quyền Zalo.
  if (path === '/channels/zalo/connect') {
    if (method !== 'GET') return json({ error: 'Chỉ hỗ trợ GET.' }, 405, { Allow: 'GET' });
    const shopId = url.searchParams.get('shop') || '';
    let ctx;
    try { ctx = await shopCtx(env, who, request, shopId); } catch { return json({ error: 'Không thể truy cập ngữ cảnh shop lúc này.' }, 503); }
    if (ctx.error) return json({ error: ctx.error, code: ctx.code }, ctx.status);
    if (!ctx.can('channels.configure_token')) return json({ error: 'Bạn không có quyền kết nối kênh cho shop này. Chỉ Chủ shop hoặc Quản lý shop mới kết nối được.', code: 'forbidden' }, 403);
    if (!clean(String(env.ZALO_APP_ID || '')) || !clean(String(env.ZALO_APP_SECRET || ''))) return json({ error: 'Máy chủ chưa cấu hình ứng dụng Zalo OA.' }, 503);
    const verifier = pkceVerifier(64);
    const challenge = await pkceChallenge(verifier);
    const state = randToken(24);
    const redirectUri = url.origin + '/auth/zalo/callback';
    const sealed = await sealCookie(env, { v: verifier, st: state, sid: ctx.shop.id, u: who.owner, exp: now() + CONNECT_TTL });
    const target = ZALO_PERMISSION + '?' + new URLSearchParams({ app_id: String(env.ZALO_APP_ID), redirect_uri: redirectUri, code_challenge: challenge, state });
    return redirectTo(target, [setCookie(CONNECT_COOKIE, sealed, CONNECT_TTL)]);
  }

  // Đăng bài viết thật lên Zalo OA: article/create rồi article/verify. Tự làm mới token nếu cần.
  if (path === '/channels/zalo/publish') {
    if (method !== 'POST') return json({ error: 'Chỉ hỗ trợ POST.' }, 405, { Allow: 'POST' });
    let ctx;
    try { ctx = await resolveShop(env, who, request); } catch { return json({ error: 'Không thể truy cập ngữ cảnh shop lúc này.' }, 503); }
    if (ctx.error) return json({ error: ctx.error, code: ctx.code }, ctx.status);
    if (!ctx.can('drafts.publish')) return json({ error: 'Vai trò của bạn trong shop này không được đăng bài.', code: 'forbidden' }, 403);
    let body;
    try { body = await readJson(request); } catch { return json({ error: 'Dữ liệu gửi lên không hợp lệ.' }, 400); }
    let title = clean(body.title);
    let content = clean(body.content);
    // Cho phép tham chiếu bản nháp theo id (nội dung nằm trong cột payload JSON của bảng drafts).
    if (clean(body.draftId) && (!title || !content)) {
      const row = await env.DB.prepare('SELECT payload FROM drafts WHERE shop_id = ? AND id = ?').bind(ctx.shop.id, clean(body.draftId)).first();
      if (!row) return json({ error: 'Không tìm thấy bản nháp trong shop này.' }, 404);
      try { const p = JSON.parse(row.payload); content = content || clean(p.content); } catch {}
    }
    if (!content) return json({ error: 'Thiếu nội dung bài viết để đăng.' }, 400);
    if (!title) title = content.split('\n').map(s => s.trim()).find(Boolean) || 'Bài viết';
    title = title.slice(0, 100);

    const channel = await env.DB.prepare('SELECT * FROM shop_channels WHERE shop_id = ? AND provider = ?').bind(ctx.shop.id, 'zalo').first();
    if (!channel || channel.status !== 'connected' || !channel.access_token) return json({ error: 'Shop chưa kết nối Zalo OA. Hãy kết nối tại mục Kênh trước khi đăng.', code: 'not_connected' }, 409);

    const fresh = await ensureFreshToken(env, env.DB, channel);
    const accessToken = fresh.token;
    // Bài viết văn bản: ánh xạ tiêu đề + nội dung bản nháp sang cấu trúc article của Zalo (không có ảnh bìa thì vẫn thử, lỗi API sẽ được trả về nguyên văn).
    const article = {
      type: 'normal',
      title,
      author: (ctx.shop && clean(ctx.shop.name)) || 'ShopPost',
      description: content.slice(0, 200),
      body: [{ type: 'text', content }],
      status: 'show'
    };
    const created = await fetchJson(ZALO_ARTICLE_CREATE, { method: 'POST', headers: { access_token: accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify(article) });
    const token = created.ok && created.data && Number(created.data.error) === 0 ? (created.data.data && created.data.data.token) : null;
    if (!token) return json({ error: 'Zalo từ chối tạo bài viết: ' + zaloError(created), code: 'zalo_error' }, 502);
    const verified = await fetchJson(ZALO_ARTICLE_VERIFY, { method: 'POST', headers: { access_token: accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    if (!(verified.ok && verified.data && Number(verified.data.error) === 0)) return json({ error: 'Zalo chưa xác nhận bài viết: ' + zaloError(verified), code: 'zalo_error' }, 502);
    const art = (verified.data && verified.data.data) || {};
    return json({ ok: true, id: art.id || art.article_id || null, url: art.url || art.link || null });
  }

  return json({ error: 'Không tìm thấy endpoint kênh.' }, 404);
}

// Callback OA từ Zalo tại /auth/zalo/callback: điều hướng cấp trang (KHÔNG có Origin) nên dựa vào cookie state đã ký, không áp dụng chặn cùng origin.
// who do worker truyền vào (danh tính phiên hiện tại) để đối chiếu với chủ phiên kết nối trong cookie.
export async function zaloCallback(request, env, who) {
  const url = new URL(request.url);
  const fail = () => redirectTo(url.origin + '/?connect_error=zalo', [clearCookie(CONNECT_COOKIE)]);
  if (!env.DB) return fail();
  await ensureChannelsSchema(env.DB);
  const data = await openCookie(env, readCookie(request, CONNECT_COOKIE) || '');
  if (!data) return fail();
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  if (url.searchParams.has('error') || !code || !state || state !== data.st) return fail();
  if (!who || !who.owner || who.owner !== data.u) return fail();
  let ctx;
  try { ctx = await shopCtx(env, who, request, data.sid); } catch { return fail(); }
  if (ctx.error || !ctx.can('channels.configure_token')) return fail();

  const redirectUri = url.origin + '/auth/zalo/callback';
  const tok = await exchangeToken(env, { code, verifier: data.v, redirectUri });
  if (!tok.ok || !tok.data || !tok.data.access_token) return fail();
  const accessToken = tok.data.access_token;
  const refreshToken = tok.data.refresh_token || null;
  const expiresAt = now() + (Number(tok.data.expires_in) || 90000);

  const oa = await getOaInfo(accessToken);
  const oaData = oa.ok && oa.data && Number(oa.data.error) === 0 ? oa.data.data : null;
  const externalId = oaData && oaData.oa_id ? String(oaData.oa_id) : (url.searchParams.get('oa_id') || null);
  const name = oaData && clean(oaData.name) ? clean(oaData.name) : 'Zalo OA';

  await upsertChannel(env.DB, { shopId: ctx.shop.id, provider: 'zalo', externalId, name, accessToken, refreshToken, expiresAt, connectedBy: who.owner });
  return redirectTo(url.origin + '/?connected=zalo', [clearCookie(CONNECT_COOKIE)]);
}

export { CONNECT_COOKIE };
