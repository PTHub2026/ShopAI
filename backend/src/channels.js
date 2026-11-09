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
const ZALO_UPLOAD_ARTICLE = 'https://openapi.zalo.me/v2.0/oa/upload/article';

const MAX_IMAGE_BYTES = 1048576; // Zalo giới hạn mỗi ảnh < 1MB.
const MAX_IMAGES = 6; // Số ảnh tối đa đính kèm mỗi bài viết.
const MAX_SCHEDULED_IMAGES_JSON = 900000; // Giữ bản ghi lịch gọn trong D1.
const PUBLISH_MAX_BYTES = 8 * 1024 * 1024; // Thân yêu cầu đăng/lịch có thể kèm ảnh data URL.

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
// Lịch đăng thật cho kênh đã kết nối (hiện dùng Zalo OA). Cron quét bản ghi đến giờ rồi đăng.
const SCHEDULED_SCHEMA = 'CREATE TABLE IF NOT EXISTS scheduled_posts (id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, provider TEXT NOT NULL, title TEXT, content TEXT, images TEXT, author TEXT, run_at INTEGER, status TEXT, result_id TEXT, result_url TEXT, error TEXT, attempts INTEGER DEFAULT 0, created_by TEXT, created_at INTEGER, updated_at INTEGER)';
const SCHEDULED_INDEX = 'CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_posts (status, run_at)';
const schemaReady = new WeakSet();
async function ensureChannelsSchema(db) {
  if (schemaReady.has(db)) return;
  await db.prepare(CHANNELS_SCHEMA).run();
  await db.prepare(SCHEDULED_SCHEMA).run();
  await db.prepare(SCHEDULED_INDEX).run();
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

// Ảnh gửi lên có thể là data URL (base64) hoặc URL http(s). Chuẩn hóa để tải lên Zalo (data URL) hoặc tham chiếu trực tiếp (http).
function normalizeImages(images) {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw new Error('Danh sách ảnh không hợp lệ.');
  if (images.length > MAX_IMAGES) throw new Error('Chỉ hỗ trợ tối đa ' + MAX_IMAGES + ' ảnh mỗi bài.');
  const out = [];
  for (const raw of images) {
    const item = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? (raw.data || raw.url || '') : '');
    const s = clean(item);
    if (!s) continue;
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(s);
    if (m) {
      const mime = clean(m[1]) || 'image/jpeg';
      if (!/^image\//i.test(mime)) throw new Error('Chỉ hỗ trợ tệp ảnh để đăng kèm.');
      let bytes;
      try { bytes = m[2] ? Uint8Array.from(atob(m[3]), c => c.charCodeAt(0)) : enc.encode(decodeURIComponent(m[3])); }
      catch { throw new Error('Dữ liệu ảnh không hợp lệ.'); }
      if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('Ảnh vượt quá 1MB; hãy dùng ảnh nhỏ hơn.');
      const ext = /png/i.test(mime) ? 'png' : /gif/i.test(mime) ? 'gif' : /webp/i.test(mime) ? 'webp' : 'jpg';
      out.push({ kind: 'upload', bytes, mime, name: 'image.' + ext });
    } else if (/^https?:\/\//i.test(s)) {
      out.push({ kind: 'url', url: s });
    } else {
      throw new Error('Ảnh phải là data URL hoặc đường dẫn http(s).');
    }
  }
  return out;
}

// Tải một ảnh lên Zalo (multipart, HEADER access_token) để lấy tham chiếu dùng cho bìa/thân bài viết.
async function uploadArticlePhoto(accessToken, bytes, filename, mime) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime || 'image/jpeg' }), filename || 'image.jpg');
  const r = await fetchJson(ZALO_UPLOAD_ARTICLE, { method: 'POST', headers: { access_token: accessToken }, body: form });
  const d = r.ok && r.data && Number(r.data.error) === 0 ? r.data.data : null;
  if (!d) throw new Error('Tải ảnh lên Zalo thất bại: ' + zaloError(r));
  const token = clean(d.token) || clean(d.photo_id) || clean(d.id);
  const url = clean(d.url) || clean(d.normalUrl) || clean(d.thumbUrl);
  if (!token && !url) throw new Error('Zalo không trả về tham chiếu ảnh hợp lệ.');
  return { token: token || null, url: url || null };
}
function coverFrom(ref) {
  if (!ref) return null;
  return ref.token ? { cover_type: 'photo', photo_id: ref.token } : { cover_type: 'photo', photo_url: ref.url };
}
function imageSegment(ref) {
  return ref.token ? { type: 'image', photo_id: ref.token } : { type: 'image', url: ref.url };
}

// Lõi đăng bài Zalo OA dùng chung cho đăng ngay và đăng theo lịch. Tự làm mới token; ném Error (thông điệp tiếng Việt) khi thất bại.
// opts: { title, content, images, author }. Ảnh đầu tiên làm bìa, các ảnh còn lại chèn vào thân bài.
export async function publishZaloArticle(env, db, channel, opts = {}) {
  const text = clean(opts.content);
  if (!text) throw new Error('Thiếu nội dung bài viết để đăng.');
  let heading = clean(opts.title);
  if (!heading) heading = text.split('\n').map(s => s.trim()).find(Boolean) || 'Bài viết';
  heading = heading.slice(0, 100);
  const normalized = normalizeImages(opts.images);
  const fresh = await ensureFreshToken(env, db, channel);
  const accessToken = fresh.token;
  const refs = [];
  for (const img of normalized) {
    if (img.kind === 'upload') refs.push(await uploadArticlePhoto(accessToken, img.bytes, img.name, img.mime));
    else refs.push({ token: null, url: img.url });
  }
  const body = [{ type: 'text', content: text }];
  for (const ref of refs.slice(1)) body.push(imageSegment(ref));
  const article = { type: 'normal', title: heading, author: clean(opts.author) || 'ShopPost', description: text.slice(0, 200), body, status: 'show' };
  if (refs[0]) article.cover = coverFrom(refs[0]);
  const created = await fetchJson(ZALO_ARTICLE_CREATE, { method: 'POST', headers: { access_token: accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify(article) });
  const token = created.ok && created.data && Number(created.data.error) === 0 ? (created.data.data && created.data.data.token) : null;
  if (!token) throw new Error('Zalo từ chối tạo bài viết: ' + zaloError(created));
  const verified = await fetchJson(ZALO_ARTICLE_VERIFY, { method: 'POST', headers: { access_token: accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  if (!(verified.ok && verified.data && Number(verified.data.error) === 0)) throw new Error('Zalo chưa xác nhận bài viết: ' + zaloError(verified));
  const art = (verified.data && verified.data.data) || {};
  return { ok: true, id: art.id || art.article_id || null, url: art.url || art.link || null };
}

// Cron: tìm các bài đến giờ và đăng lên kênh thật. Mỗi bài xử lý độc lập (try/catch riêng) để một lỗi không chặn bài khác.
export async function runDueScheduledPosts(env) {
  if (!env || !env.DB) return { processed: 0 };
  await ensureChannelsSchema(env.DB);
  const t = now();
  const { results } = await env.DB.prepare("SELECT * FROM scheduled_posts WHERE status = 'scheduled' AND run_at <= ? ORDER BY run_at ASC LIMIT 25").bind(t).all();
  let processed = 0;
  for (const row of results || []) {
    try {
      const channel = await env.DB.prepare('SELECT * FROM shop_channels WHERE shop_id = ? AND provider = ?').bind(row.shop_id, row.provider).first();
      if (!channel || channel.status !== 'connected' || !channel.access_token) throw new Error('Shop chưa kết nối ' + (row.provider === 'zalo' ? 'Zalo OA' : row.provider) + '.');
      let images = [];
      try { images = JSON.parse(row.images || '[]'); } catch {}
      const res = await publishZaloArticle(env, env.DB, channel, { title: row.title, content: row.content, images, author: row.author });
      await env.DB.prepare("UPDATE scheduled_posts SET status = 'posted', result_id = ?, result_url = ?, error = NULL, updated_at = ? WHERE id = ? AND status = 'scheduled'")
        .bind(res.id || null, res.url || null, now(), row.id).run();
    } catch (e) {
      await env.DB.prepare("UPDATE scheduled_posts SET status = 'failed', error = ?, attempts = COALESCE(attempts, 0) + 1, updated_at = ? WHERE id = ? AND status = 'scheduled'")
        .bind(String((e && e.message) || 'Đăng thất bại.').slice(0, 500), now(), row.id).run();
    }
    processed++;
  }
  return { processed };
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

  // Đăng bài viết thật lên Zalo OA (kèm ảnh nếu có): tải ảnh → article/create → article/verify. Tự làm mới token nếu cần.
  if (path === '/channels/zalo/publish') {
    if (method !== 'POST') return json({ error: 'Chỉ hỗ trợ POST.' }, 405, { Allow: 'POST' });
    let ctx;
    try { ctx = await resolveShop(env, who, request); } catch { return json({ error: 'Không thể truy cập ngữ cảnh shop lúc này.' }, 503); }
    if (ctx.error) return json({ error: ctx.error, code: ctx.code }, ctx.status);
    if (!ctx.can('drafts.publish')) return json({ error: 'Vai trò của bạn trong shop này không được đăng bài.', code: 'forbidden' }, 403);
    let body;
    try { body = await readJson(request, PUBLISH_MAX_BYTES); } catch { return json({ error: 'Dữ liệu gửi lên không hợp lệ.' }, 400); }
    let title = clean(body.title);
    let content = clean(body.content);
    // Cho phép tham chiếu bản nháp theo id (nội dung nằm trong cột payload JSON của bảng drafts).
    if (clean(body.draftId) && (!title || !content)) {
      const row = await env.DB.prepare('SELECT payload FROM drafts WHERE shop_id = ? AND id = ?').bind(ctx.shop.id, clean(body.draftId)).first();
      if (!row) return json({ error: 'Không tìm thấy bản nháp trong shop này.' }, 404);
      try { const p = JSON.parse(row.payload); content = content || clean(p.content); } catch {}
    }
    if (!content) return json({ error: 'Thiếu nội dung bài viết để đăng.' }, 400);

    const channel = await env.DB.prepare('SELECT * FROM shop_channels WHERE shop_id = ? AND provider = ?').bind(ctx.shop.id, 'zalo').first();
    if (!channel || channel.status !== 'connected' || !channel.access_token) return json({ error: 'Shop chưa kết nối Zalo OA. Hãy kết nối tại mục Kênh trước khi đăng.', code: 'not_connected' }, 409);

    try {
      const res = await publishZaloArticle(env, env.DB, channel, { title, content, images: body.images, author: (ctx.shop && clean(ctx.shop.name)) || 'ShopPost' });
      return json({ ok: true, id: res.id, url: res.url });
    } catch (e) {
      return json({ error: (e && e.message) || 'Đăng bài Zalo thất bại.', code: 'zalo_error' }, 502);
    }
  }

  // Tạo lịch đăng thật cho kênh Zalo OA. Cron sẽ tự đăng khi đến giờ.
  if (path === '/channels/zalo/schedule') {
    if (method !== 'POST') return json({ error: 'Chỉ hỗ trợ POST.' }, 405, { Allow: 'POST' });
    let ctx;
    try { ctx = await resolveShop(env, who, request); } catch { return json({ error: 'Không thể truy cập ngữ cảnh shop lúc này.' }, 503); }
    if (ctx.error) return json({ error: ctx.error, code: ctx.code }, ctx.status);
    if (!ctx.can('drafts.publish')) return json({ error: 'Vai trò của bạn trong shop này không được đăng bài.', code: 'forbidden' }, 403);
    let body;
    try { body = await readJson(request, PUBLISH_MAX_BYTES); } catch { return json({ error: 'Dữ liệu gửi lên không hợp lệ.' }, 400); }
    const content = clean(body.content);
    if (!content) return json({ error: 'Thiếu nội dung bài viết để lên lịch.' }, 400);
    const runAt = Math.floor(Number(body.runAt));
    if (!Number.isFinite(runAt) || runAt <= now()) return json({ error: 'Thời gian lên lịch phải ở tương lai.' }, 400);
    // Kiểm tra ảnh hợp lệ ngay lúc tạo lịch để báo lỗi sớm; lưu nguyên data URL để cron tải lên Zalo khi đăng.
    try { normalizeImages(body.images); } catch (e) { return json({ error: (e && e.message) || 'Ảnh không hợp lệ.' }, 400); }
    const imagesJson = JSON.stringify(Array.isArray(body.images) ? body.images : []);
    if (imagesJson.length > MAX_SCHEDULED_IMAGES_JSON) return json({ error: 'Ảnh đính kèm quá lớn để lên lịch; hãy giảm số lượng hoặc kích thước ảnh.' }, 413);

    const channel = await env.DB.prepare('SELECT * FROM shop_channels WHERE shop_id = ? AND provider = ?').bind(ctx.shop.id, 'zalo').first();
    if (!channel || channel.status !== 'connected' || !channel.access_token) return json({ error: 'Shop chưa kết nối Zalo OA. Hãy kết nối tại mục Kênh trước khi lên lịch.', code: 'not_connected' }, 409);

    const id = 's_' + randToken(12);
    const t = now();
    const title = clean(body.title).slice(0, 100);
    const author = (ctx.shop && clean(ctx.shop.name)) || 'ShopPost';
    await env.DB.prepare('INSERT INTO scheduled_posts (id, shop_id, provider, title, content, images, author, run_at, status, attempts, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)')
      .bind(id, ctx.shop.id, 'zalo', title, content, imagesJson, author, runAt, 'scheduled', who.owner, t, t).run();
    return json({ ok: true, id, runAt, status: 'scheduled' });
  }

  // Danh sách lịch đăng của shop (KHÔNG trả token/ảnh gốc).
  if (path === '/channels/scheduled') {
    if (method !== 'GET') return json({ error: 'Chỉ hỗ trợ GET.' }, 405, { Allow: 'GET' });
    let ctx;
    try { ctx = await resolveShop(env, who, request); } catch { return json({ error: 'Không thể truy cập ngữ cảnh shop lúc này.' }, 503); }
    if (ctx.error) return json({ error: ctx.error, code: ctx.code }, ctx.status);
    if (!ctx.can('drafts.view')) return json({ error: 'Vai trò của bạn trong shop này không được xem lịch đăng.', code: 'forbidden' }, 403);
    const { results } = await env.DB.prepare('SELECT id, provider, title, content, run_at, status, result_url, error, created_at FROM scheduled_posts WHERE shop_id = ? ORDER BY run_at DESC LIMIT 200').bind(ctx.shop.id).all();
    const list = (results || []).map(r => ({ id: r.id, provider: r.provider, title: r.title || '', content: (r.content || '').slice(0, 280), run_at: Number(r.run_at) || null, status: r.status || 'scheduled', url: r.result_url || null, error: r.error || null, created_at: Number(r.created_at) || null }));
    return json({ scheduled: list });
  }

  // Hủy một lịch đăng chưa chạy.
  const cancel = /^\/channels\/scheduled\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (cancel) {
    if (method !== 'DELETE') return json({ error: 'Chỉ hỗ trợ DELETE.' }, 405, { Allow: 'DELETE' });
    let ctx;
    try { ctx = await resolveShop(env, who, request); } catch { return json({ error: 'Không thể truy cập ngữ cảnh shop lúc này.' }, 503); }
    if (ctx.error) return json({ error: ctx.error, code: ctx.code }, ctx.status);
    if (!ctx.can('drafts.publish')) return json({ error: 'Vai trò của bạn trong shop này không được hủy lịch đăng.', code: 'forbidden' }, 403);
    const res = await env.DB.prepare("DELETE FROM scheduled_posts WHERE shop_id = ? AND id = ? AND status = 'scheduled'").bind(ctx.shop.id, cancel[1]).run();
    return json({ deleted: res.meta.changes > 0 });
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
