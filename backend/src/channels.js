import {normalizeImages,validatePost,providerFailure} from './provider-adapters.js';
import { ensureChannelStore } from './channel-store.js';
import { handleSocial, ensureSocialSchema, runDuePublishJobs, importLegacyScheduledPosts } from './social.js';
// Kết nối kênh thật cho shop. Hiện triển khai Zalo OA (OAuth v4 + PKCE) và đăng bài viết thật.
// Telegram, Facebook và Instagram dùng cùng kho kênh/hàng đợi qua adapter riêng.
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
const ZALO_ARTICLE_CREATE = 'https://openapi.zalo.me/v2.0/article/create';
const ZALO_ARTICLE_VERIFY = 'https://openapi.zalo.me/v2.0/article/verify';

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

// Tokens are bound to the shop/provider/field and encrypted with the stable Worker secret.
async function tokenKey(env) {
 const raw = Uint8Array.from(atob(env.SOCIAL_TOKEN_KEY || ''), c => c.charCodeAt(0));
 if(raw.length !== 32) throw Error('Máy chủ chưa cấu hình khóa bảo vệ kênh.');
 return crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']);
}
async function protectToken(env,shop,kind,value) {
 if(!value)return null;
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(shop+':zalo:'+kind)},await tokenKey(env),enc.encode(value));
 return 'enc1.'+b64url(iv)+'.'+b64url(new Uint8Array(cipher));
}
async function unprotectToken(env,shop,kind,value) {
 if(!value)return null;
 if(!value.startsWith('enc1.'))return value; // Upgrade existing records on first successful access.
 const [,iv,cipher]=value.split('.');
 return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:Uint8Array.from(fromB64url(iv),c=>c.charCodeAt(0)),additionalData:enc.encode(shop+':zalo:'+kind)},await tokenKey(env),Uint8Array.from(fromB64url(cipher),c=>c.charCodeAt(0))));
}
const STATE_SCHEMA = 'CREATE TABLE IF NOT EXISTS channel_oauth_states (state TEXT PRIMARY KEY, actor TEXT NOT NULL, shop_id TEXT NOT NULL, expires_at INTEGER NOT NULL)';
const REFRESH_SCHEMA = 'CREATE TABLE IF NOT EXISTS channel_refresh_locks (shop_id TEXT NOT NULL, provider TEXT NOT NULL, lease TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(shop_id,provider))';

// Schema tạo lúc chạy (idempotent) vì Workers Builds không chạy migration tự động.
// Lịch đăng thật cho kênh đã kết nối (hiện dùng Zalo OA). Cron quét bản ghi đến giờ rồi đăng.
const SCHEDULED_SCHEMA = 'CREATE TABLE IF NOT EXISTS scheduled_posts (id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, provider TEXT NOT NULL, title TEXT, content TEXT, images TEXT, author TEXT, run_at INTEGER, status TEXT, result_id TEXT, result_url TEXT, error TEXT, attempts INTEGER DEFAULT 0, created_by TEXT, created_at INTEGER, updated_at INTEGER)';
const SCHEDULED_INDEX = 'CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_posts (status, run_at)';
const schemaReady = new WeakSet();
async function ensureChannelsSchema(db) {
  if (schemaReady.has(db)) return;
  await ensureChannelStore(db);
  await db.prepare(SCHEDULED_SCHEMA).run();
  await db.prepare(SCHEDULED_INDEX).run();
  await db.prepare(STATE_SCHEMA).run();
  await db.prepare(REFRESH_SCHEMA).run();
  await db.prepare('CREATE TABLE IF NOT EXISTS channel_public_media (id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, mime TEXT NOT NULL, body BLOB NOT NULL, created_at INTEGER NOT NULL)').run();
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

async function upsertChannel(db,env, { shopId, provider, externalId, name, accessToken, refreshToken, expiresAt, connectedBy, expected }) {
  const t = now();
  accessToken=await protectToken(env,shopId,'access',accessToken);
  refreshToken=await protectToken(env,shopId,'refresh',refreshToken);
  const saved=await db.prepare(
    'INSERT INTO channels (shop_id, provider, external_id, name, token, refresh_token, expires_at, status, connected_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(shop_id, provider) WHERE provider=\'zalo\' DO UPDATE SET external_id = excluded.external_id, name = excluded.name, token = excluded.token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, status = excluded.status, connected_by = excluded.connected_by, created_at = excluded.created_at, updated_at = excluded.updated_at WHERE channels.token IS ? AND channels.refresh_token IS ? AND channels.external_id IS ?'
  ).bind(shopId, provider, externalId, name, accessToken, refreshToken, expiresAt, 'connected', connectedBy, t, t, expected?.token??null,expected?.refresh_token??null,expected?.external_id??null).run();
  if(saved.meta.changes!==1)throw Error('Kết nối OA đã thay đổi. Hãy kết nối lại.');
}
async function persistTokens(db, env, shopId, provider, { accessToken, refreshToken, expiresAt }, expected) {
  accessToken=await protectToken(env,shopId,'access',accessToken);
  refreshToken=await protectToken(env,shopId,'refresh',refreshToken);
  const saved=await db.prepare("UPDATE channels SET token = ?, refresh_token = ?, expires_at = ?, updated_at = ? WHERE shop_id = ? AND provider = ? AND token IS ? AND refresh_token IS ? AND status='connected'")
    .bind(accessToken, refreshToken, expiresAt, now(), shopId, provider,expected.token,expected.refresh_token).run();
  if(saved.meta.changes!==1)throw Error('Kết nối OA đã thay đổi. Hãy kết nối lại.');
}

// Làm mới access_token nếu sắp/đã hết hạn và lưu lại cặp token mới (refresh_token Zalo dùng một lần, phải lưu cái mới trả về).
async function ensureFreshToken(env, db, channel) {
 const access=await unprotectToken(env,channel.shop_id,'access',channel.token);
 const refresh=await unprotectToken(env,channel.shop_id,'refresh',channel.refresh_token);
 if(!/^\d+$/.test(String(channel.external_id||'')))throw Object.assign(Error('Cần kết nối lại Zalo OA để xác minh danh tính.'),{reauth:true});
 if(!channel.token.startsWith('enc1.')){
  const verified=await getOaInfo(access);
  if(!verified.ok||Number(verified.data?.error)!==0||String(verified.data?.data?.oa_id||'')!==String(channel.external_id))throw Object.assign(Error('Cần kết nối lại Zalo OA để xác minh quyền truy cập.'),{reauth:true});
  const a=await protectToken(env,channel.shop_id,'access',access),r=await protectToken(env,channel.shop_id,'refresh',refresh);
  await db.prepare('UPDATE channels SET token=?,refresh_token=? WHERE shop_id=? AND provider=? AND token=? AND refresh_token IS ?').bind(a,r,channel.shop_id,channel.provider,channel.token,channel.refresh_token).run();
 }
 if(channel.expires_at && Number(channel.expires_at)-now()>REFRESH_SKEW){
  return {token:access};
 }
 if(!refresh)throw Object.assign(Error('Phiên Zalo OA đã hết hạn. Hãy kết nối lại OA tại mục Kênh.'),{reauth:true});
 const lease=randToken();
 const lock=await db.prepare('INSERT INTO channel_refresh_locks(shop_id,provider,lease,expires_at) VALUES(?,?,?,?) ON CONFLICT(shop_id,provider) DO UPDATE SET lease=excluded.lease,expires_at=excluded.expires_at WHERE channel_refresh_locks.expires_at<=?').bind(channel.shop_id,channel.provider,lease,now()+30,now()).run();
 if(lock.meta.changes!==1)throw Object.assign(Error('Phiên Zalo đang được làm mới. Vui lòng thử lại sau ít giây.'),{safeToRetry:true,retryAfter:30});
 try{
  const latest=await db.prepare('SELECT * FROM channels WHERE shop_id=? AND provider=?').bind(channel.shop_id,channel.provider).first();
  if(!latest||latest.status!=='connected')throw Object.assign(Error('OA không còn kết nối. Hãy cấp quyền lại.'),{reauth:true});
  if(Number(latest.expires_at)-now()>REFRESH_SKEW)return {token:await unprotectToken(env,latest.shop_id,'access',latest.token)};
  const currentRefresh=await unprotectToken(env,latest.shop_id,'refresh',latest.refresh_token);
  if(!currentRefresh)throw Object.assign(Error('Cần kết nối lại Zalo OA.'),{reauth:true});
  let r;
  try{r=await refreshAccessToken(env,currentRefresh);}catch{r=null;}
  if(!r?.ok||!r.data?.access_token||!r.data?.refresh_token){
   await db.prepare("UPDATE channels SET status='reauth_required',refresh_token=NULL,updated_at=? WHERE shop_id=? AND provider=? AND token IS ? AND refresh_token IS ?").bind(now(),channel.shop_id,channel.provider,latest.token,latest.refresh_token).run();
   throw Object.assign(Error('Không thể làm mới phiên Zalo. Hãy kết nối lại OA tại mục Kênh.'),{reauth:true});
  }
  const expiresAt=now()+Number(r.data.expires_in||90000);
  await persistTokens(db,env,channel.shop_id,channel.provider,{accessToken:r.data.access_token,refreshToken:r.data.refresh_token,expiresAt},latest);
  return {token:r.data.access_token};
 }finally{await db.prepare('DELETE FROM channel_refresh_locks WHERE shop_id=? AND provider=? AND lease=?').bind(channel.shop_id,channel.provider,lease).run();}
}

// Ảnh gửi lên có thể là data URL (base64) hoặc URL http(s). Chuẩn hóa để tải lên Zalo (data URL) hoặc tham chiếu trực tiếp (http).
// Public, unguessable image URLs are created only when the user submits a post.
// Article API requires a photo URL; the messaging attachment API is a different API.
async function articlePhoto(env,db,shop,img) {
 const b=img.bytes;
 const mime=b[0]===137&&b[1]===80&&b[2]===78&&b[3]===71?'image/png':b[0]===255&&b[1]===216&&b[2]===255?'image/jpeg':b[0]===71&&b[1]===73&&b[2]===70?'image/gif':b[0]===82&&b[1]===73&&b[2]===70&&b[8]===87&&b[9]===69&&b[10]===66&&b[11]===80?'image/webp':null;
 if(!mime)throw Error('Ảnh bìa cần là JPG, PNG, GIF hoặc WebP hợp lệ.');
 await ensureChannelsSchema(db);
 const id=Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join('');
 const origin=new URL(env.PUBLIC_ORIGIN);
 if(origin.protocol!=='https:')throw Error('Máy chủ chưa có địa chỉ ảnh HTTPS hợp lệ.');
 await db.prepare('INSERT INTO channel_public_media(id,shop_id,mime,body,created_at) VALUES(?,?,?,?,?)').bind(id,shop,mime,b,now()).run();
 return origin.origin+'/media/zalo/'+id;
}
export async function publicZaloMedia(request,env) {
 const path=new URL(request.url).pathname;
 const id=/^\/media\/zalo\/([a-f0-9]{64})$/.exec(path)?.[1];
 const h={'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Referrer-Policy':'no-referrer'};
 if(!id||!env.DB)return new Response(null,{status:404,headers:h});
 if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405,headers:{...h,Allow:'GET, HEAD'}});
 await ensureChannelsSchema(env.DB);
 const row=await env.DB.prepare('SELECT mime,body FROM channel_public_media WHERE id=?').bind(id).first();
 if(!row||!['image/png','image/jpeg','image/gif','image/webp'].includes(row.mime))return new Response(null,{status:404,headers:h});
 return new Response(request.method==='HEAD'?null:new Uint8Array(row.body),{headers:{...h,'Content-Type':row.mime,'Cache-Control':'public, max-age=86400'}});
}
function coverFrom(ref){return ref?{cover_type:'photo',photo_url:ref,status:'show'}:null;}
function imageSegment(ref){return {type:'image',url:ref};}

// Lõi đăng bài Zalo OA dùng chung cho đăng ngay và đăng theo lịch. Tự làm mới token; ném Error (thông điệp tiếng Việt) khi thất bại.
// opts: { title, content, images, author }. Ảnh đầu tiên làm bìa, các ảnh còn lại chèn vào thân bài.
export async function publishZaloArticle(env, db, channel, opts = {}) {
  validatePost('zalo',{kind:'photo',text:opts.content,images:opts.images});
  const text = clean(opts.content);
  let heading = clean(opts.title);
  if (!heading) heading = text.split('\n').map(s => s.trim()).find(Boolean) || 'Bài viết';
  heading = heading.slice(0, 100);
  const normalized = normalizeImages(opts.images);
  const fresh = await ensureFreshToken(env, db, channel);
  const accessToken = fresh.token;
  const refs = [];
  for (const img of normalized) {
    if (img.kind === 'upload') refs.push(await articlePhoto(env,db,channel.shop_id,img));
    else refs.push(img.url);
  }
  const body = [{ type: 'text', content: text }];
  for (const ref of refs.slice(1)) body.push(imageSegment(ref));
  const article = { type: 'normal', title: heading, author: (clean(opts.author) || 'Shoppost').slice(0,50), description: text.slice(0, 200), body, status: 'show' };
  if (refs[0]) article.cover = coverFrom(refs[0]);
  const created = await fetchJson(ZALO_ARTICLE_CREATE, { method: 'POST', headers: { access_token: accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify(article) });
  const token = created.ok && created.data && Number(created.data.error) === 0 ? (created.data.data && created.data.data.token) : null;
  if (!token) throw providerFailure(created,'Zalo từ chối tạo bài viết: '+zaloError(created));
  const verified = await fetchJson(ZALO_ARTICLE_VERIFY, { method: 'POST', headers: { access_token: accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  if (!(verified.ok && verified.data && Number(verified.data.error) === 0)) throw Object.assign(new Error('Zalo chưa xác nhận bài viết: '+zaloError(verified)),{deliveryUncertain:true});
  const art = (verified.data && verified.data.data) || {};
  if(!art.id&&!art.article_id)throw Error('Zalo chưa xác nhận mã bài viết. Kiểm tra OA trước khi đăng lại.');
  return { ok: true, id: art.id || art.article_id, url: art.url || art.link || null };
}

// Cron: tìm các bài đến giờ và đăng lên kênh thật. Mỗi bài xử lý độc lập (try/catch riêng) để một lỗi không chặn bài khác.
export async function runDueScheduledPosts(env) {
 if(!env?.DB)return {processed:0};
 await ensureChannelsSchema(env.DB);
 return runDuePublishJobs(env);
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

  if(/^\/channels\/zalo\/(accounts|jobs)(\/.*)?$/.test(path)){
    const target=new URL(request.url);target.pathname=path.replace('/channels/zalo/','/api/social/');
    const h=new Headers(request.headers);h.set('X-Channel-Provider','zalo');
    return handleSocial(new Request(target,{method,headers:h,...(!['GET','HEAD'].includes(method)?{body:await request.arrayBuffer()}:{}),signal:request.signal}),env,who,json);
  }
  const unified = /^\/channels\/(all|telegram|facebook|instagram|meta)\/(accounts|connect|publish|schedule|jobs|providers|start)(\/.*)?$/.exec(path);
  if(unified){
    const [,provider,operation,rest='']=unified;
    let section=operation==='connect'?'accounts':operation==='publish'||operation==='schedule'?'jobs':operation;
    if(provider==='meta')section='meta/'+operation;
    const target=new URL(request.url);target.pathname='/api/social/'+section+rest;
    const h=new Headers(request.headers);h.set('X-Channel-Provider',provider);
    if(operation==='schedule')h.set('X-Channel-Schedule','1');
    return handleSocial(new Request(target,{method,headers:h,...(!['GET','HEAD'].includes(method)?{body:await request.arrayBuffer()}:{}),signal:request.signal}),env,who,json);
  }

  // Danh sách kênh của shop — KHÔNG trả access_token/refresh_token.
  if (path === '/channels') {
    if (method !== 'GET') return json({ error: 'Chỉ hỗ trợ GET.' }, 405, { Allow: 'GET' });
    let ctx;
    try { ctx = await resolveShop(env, who, request); } catch { return json({ error: 'Không thể truy cập ngữ cảnh shop lúc này.' }, 503); }
    if (ctx.error) return json({ error: ctx.error, code: ctx.code }, ctx.status);
    if (!ctx.can('channels.view')) return json({ error: 'Vai trò của bạn trong shop này không được xem kênh.', code: 'forbidden' }, 403);
    const { results } = await env.DB.prepare('SELECT provider, external_id, name, status, created_at, expires_at FROM channels WHERE shop_id = ?').bind(ctx.shop.id).all();
    const list = (results || []).map(r => {
      const needsReconnect=r.status==='reauth_required'||(r.provider==='zalo'&&!/^\d+$/.test(String(r.external_id||'')));
      return {provider:r.provider,external_id:r.external_id,oa_id:r.provider==='zalo'?r.external_id:null,name:r.name,status:needsReconnect?'reauth_required':r.status,connected_at:Number(r.created_at)||null,created_at:Number(r.created_at)||null,expires_at:Number(r.expires_at)||null,needsReconnect};
    });
    let keyReady=false;try{await tokenKey(env);keyReady=true;}catch{}
    return json({ channels:list, setup:{zalo:{configured:Boolean(env.ZALO_APP_ID&&env.ZALO_APP_SECRET&&keyReady),canConnect:ctx.can('channels.configure_token'),callbackUri:url.origin+'/auth/zalo/callback'}} });
  }

  if (path === '/channels/zalo') {
    if (method !== 'DELETE') return json({error:'Chỉ hỗ trợ DELETE.'},405,{Allow:'DELETE'});
    const ctx = await resolveShop(env,who,request);
    if(ctx.error)return json({error:ctx.error,code:ctx.code},ctx.status);
    if(!ctx.can('channels.configure_token'))return json({error:'Bạn không có quyền ngắt kết nối.',code:'forbidden'},403);
    await ensureSocialSchema(env.DB);
    const legacy=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shop_channels'").first();
    await env.DB.batch([
      ...(legacy?[env.DB.prepare('DELETE FROM shop_channels WHERE shop_id=? AND provider=?').bind(ctx.shop.id,'zalo')]:[]),
      env.DB.prepare("UPDATE publish_jobs SET status='failed',error_code='account_revoked',updated_at=? WHERE shop_id=? AND account_id IN (SELECT id FROM channels WHERE shop_id=? AND provider='zalo') AND status IN ('pending','retryable')").bind(now(),ctx.shop.id,ctx.shop.id),
      env.DB.prepare('DELETE FROM channels WHERE shop_id=? AND provider=?').bind(ctx.shop.id,'zalo'),
      env.DB.prepare('DELETE FROM channel_oauth_states WHERE shop_id=?').bind(ctx.shop.id),
      env.DB.prepare('DELETE FROM channel_refresh_locks WHERE shop_id=? AND provider=?').bind(ctx.shop.id,'zalo'),
      env.DB.prepare("UPDATE scheduled_posts SET status='cancelled',updated_at=? WHERE shop_id=? AND provider='zalo' AND status='scheduled'").bind(now(),ctx.shop.id),
      env.DB.prepare('INSERT INTO audit_log(shop_id,actor,action,target,detail,created_at) VALUES(?,?,?,?,?,?)').bind(ctx.shop.id,who.owner,'channels.disconnect','zalo',JSON.stringify({provider:'zalo'}),now())
    ]);
    return json({ok:true});
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
    try{await tokenKey(env);}catch{return json({error:'Máy chủ chưa cấu hình khóa bảo vệ kênh.'},503);}
    const verifier = pkceVerifier(64);
    const challenge = await pkceChallenge(verifier);
    const state = randToken(24);
    await env.DB.prepare('DELETE FROM channel_oauth_states WHERE expires_at<=?').bind(now()).run();
    await env.DB.prepare('INSERT INTO channel_oauth_states(state,actor,shop_id,expires_at) VALUES(?,?,?,?)').bind(state,who.owner,ctx.shop.id,now()+CONNECT_TTL).run();
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

    const channel = await env.DB.prepare('SELECT * FROM channels WHERE shop_id = ? AND provider = ?').bind(ctx.shop.id, 'zalo').first();
    if (!channel || channel.status !== 'connected' || !channel.token) return json({ error: 'Shop chưa kết nối Zalo OA. Hãy kết nối tại mục Kênh trước khi đăng.', code: 'not_connected' }, 409);

    await ensureSocialSchema(env.DB);
    const target=new URL(request.url);target.pathname='/api/social/jobs';
    const h=new Headers(request.headers);h.set('Content-Type','application/json');h.set('X-Channel-Provider','zalo');
    h.set('Idempotency-Key',request.headers.get('Idempotency-Key')||'zalo-'+crypto.randomUUID());
    return handleSocial(new Request(target,{method:'POST',headers:h,body:JSON.stringify({accountId:channel.id,kind:'photo',text:content,title,images:body.images,author:ctx.shop.name})}),env,who,json);
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
    const channel = await env.DB.prepare('SELECT * FROM channels WHERE shop_id = ? AND provider = ?').bind(ctx.shop.id, 'zalo').first();
    if (!channel || channel.status !== 'connected' || !channel.token) return json({ error: 'Shop chưa kết nối Zalo OA. Hãy kết nối tại mục Kênh trước khi lên lịch.', code: 'not_connected' }, 409);

    await ensureSocialSchema(env.DB);
    const target=new URL(request.url);target.pathname='/api/social/jobs';
    const h=new Headers(request.headers);h.set('Content-Type','application/json');h.set('X-Channel-Provider','zalo');h.set('X-Channel-Schedule','1');
    h.set('Idempotency-Key',request.headers.get('Idempotency-Key')||'schedule-'+crypto.randomUUID());
    return handleSocial(new Request(target,{method:'POST',headers:h,body:JSON.stringify({accountId:channel.id,kind:'photo',text:content,title:body.title,images:body.images,author:ctx.shop.name,runAt})}),env,who,json);
  }


  // Danh sách lịch đăng của shop (KHÔNG trả token/ảnh gốc).
  if (path === '/channels/scheduled') {
    if (method !== 'GET') return json({ error: 'Chỉ hỗ trợ GET.' }, 405, { Allow: 'GET' });
    let ctx;
    try { ctx = await resolveShop(env, who, request); } catch { return json({ error: 'Không thể truy cập ngữ cảnh shop lúc này.' }, 503); }
    if (ctx.error) return json({ error: ctx.error, code: ctx.code }, ctx.status);
    if (!ctx.can('drafts.view')) return json({ error: 'Vai trò của bạn trong shop này không được xem lịch đăng.', code: 'forbidden' }, 403);
    await ensureSocialSchema(env.DB);
    await importLegacyScheduledPosts(env.DB);
    const {results}=await env.DB.prepare("SELECT j.id,c.provider,j.payload,j.next_attempt_at,j.status,j.result_url,j.error_code,j.created_at FROM publish_jobs j JOIN channels c ON c.id=j.account_id AND c.shop_id=j.shop_id WHERE j.shop_id=? ORDER BY j.created_at DESC LIMIT 200").bind(ctx.shop.id).all();
    const list=(results||[]).map(j=>{const p=JSON.parse(j.payload);return {id:j.id,provider:j.provider,title:p.title||'',content:(p.text||'').slice(0,280),run_at:j.next_attempt_at,status:({sent:'posted',pending:'scheduled',retryable:'scheduled',sending:'processing'})[j.status]||j.status,url:j.result_url,error:j.error_code,created_at:j.created_at};});
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
    await ensureSocialSchema(env.DB);
    const res=await env.DB.prepare("UPDATE publish_jobs SET status='failed',error_code='cancelled',updated_at=? WHERE shop_id=? AND id=? AND status IN ('pending','retryable')").bind(now(),ctx.shop.id,cancel[1]).run();
    await env.DB.prepare("UPDATE scheduled_posts SET status='cancelled' WHERE shop_id=? AND id=? AND status='scheduled'").bind(ctx.shop.id,cancel[1]).run();
    return json({ deleted: res.meta.changes > 0 });
  }

  return json({ error: 'Không tìm thấy endpoint kênh.' }, 404);
}

// Callback OA từ Zalo tại /auth/zalo/callback: điều hướng cấp trang (KHÔNG có Origin) nên dựa vào cookie state đã ký, không áp dụng chặn cùng origin.
// who do worker truyền vào (danh tính phiên hiện tại) để đối chiếu với chủ phiên kết nối trong cookie.
export async function zaloCallback(request, env, who) {
  const url = new URL(request.url);
  const fail = (reason='authorization_failed') => redirectTo(url.origin + '/?connect_error=zalo&connect_reason='+encodeURIComponent(reason)+'#accounts', [clearCookie(CONNECT_COOKIE)]);
  if (!env.DB) return fail();
  await ensureChannelsSchema(env.DB);
  const data = await openCookie(env, readCookie(request, CONNECT_COOKIE) || '');
  if (!data) return fail('session_expired');
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  if (url.searchParams.has('error') || !code || !state || state !== data.st) return fail();
  if (!who || !who.owner || who.owner !== data.u) return fail('account_changed');
  let ctx;
  try { ctx = await shopCtx(env, who, request, data.sid); } catch { return fail(); }
  if (ctx.error || !ctx.can('channels.configure_token')) return fail();
  const used=await env.DB.prepare('DELETE FROM channel_oauth_states WHERE state=? AND actor=? AND shop_id=? AND expires_at>?').bind(state,who.owner,ctx.shop.id,now()).run();
  if(used.meta.changes!==1)return fail();

  try {
  await ensureSocialSchema(env.DB);
  await importLegacyScheduledPosts(env.DB);
  const expected=await env.DB.prepare('SELECT * FROM channels WHERE shop_id=? AND provider=?').bind(ctx.shop.id,'zalo').first();
  const redirectUri = url.origin + '/auth/zalo/callback';
  const tok = await exchangeToken(env, { code, verifier: data.v, redirectUri });
  if (!tok.ok || !tok.data || !tok.data.access_token) return fail();
  const accessToken = tok.data.access_token;
  const refreshToken = tok.data.refresh_token || null;
  const expiresAt = now() + (Number(tok.data.expires_in) || 90000);

  const oa = await getOaInfo(accessToken);
  const oaData = oa.ok && oa.data && Number(oa.data.error) === 0 ? oa.data.data : null;
  if(!oaData || !/^\d+$/.test(String(oaData.oa_id||'')))return fail('oa_unavailable');
  const externalId = String(oaData.oa_id);
  const name = oaData && clean(oaData.name) ? clean(oaData.name) : 'Zalo OA';

  await upsertChannel(env.DB, env, { shopId: ctx.shop.id, provider: 'zalo', externalId, name, accessToken, refreshToken, expiresAt, connectedBy: who.owner, expected });
  return redirectTo(url.origin + '/?connected=zalo#accounts', [clearCookie(CONNECT_COOKIE)]);
  }catch{return fail('temporary_error');}
}

export { CONNECT_COOKIE };
