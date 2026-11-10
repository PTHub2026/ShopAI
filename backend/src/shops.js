import { emailConfigured, inviteEmail, normalizeEmail, readJson, sendEmail } from './auth.js';
import { ROLES, ROLE_LABELS, allowedActions, can, isPlatformAdmin, isRole } from './permissions.js';

// Giữ đồng bộ với backend/migrations/0003_shops_roles.sql (kiểm thử so khớp hai nơi).
// Worker tự tạo schema lúc chạy (idempotent) vì Workers Builds không chạy migration; file migration dùng để áp thủ công.
export const SHOP_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS shops (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  'CREATE INDEX IF NOT EXISTS shops_owner ON shops(owner, created_at)',
  "CREATE TABLE IF NOT EXISTS shop_members (shop_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'content', 'support', 'viewer')), can_publish INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, invited_by TEXT, PRIMARY KEY (shop_id, user_id))",
  'CREATE INDEX IF NOT EXISTS shop_members_user ON shop_members(user_id, created_at)',
  "CREATE TABLE IF NOT EXISTS shop_invites (id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, email TEXT, role TEXT NOT NULL CHECK (role IN ('manager', 'content', 'support', 'viewer')), token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, accepted_by TEXT, accepted_at INTEGER, revoked_at INTEGER)",
  'CREATE INDEX IF NOT EXISTS shop_invites_shop ON shop_invites(shop_id, created_at)',
  'CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, shop_id TEXT, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT CHECK (detail IS NULL OR json_valid(detail)), created_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS audit_log_created ON audit_log(created_at)',
  'CREATE TABLE IF NOT EXISTS identity_links (owner TEXT PRIMARY KEY, email TEXT NOT NULL, source TEXT NOT NULL, verified_at INTEGER NOT NULL, created_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS identity_links_email ON identity_links(email)'
];
// Cột bổ sung cho bảng drafts (nullable / có mặc định), thêm bằng ALTER sau khi kiểm tra PRAGMA table_info. Không xóa hay đổi cột cũ.
export const DRAFT_COLUMNS = [
  ['shop_id', 'TEXT'],
  ['status', "TEXT NOT NULL DEFAULT 'draft'"],
  ['assigned_to', 'TEXT'],
  ['created_by', 'TEXT']
];
export const DRAFT_INDEX = 'CREATE INDEX IF NOT EXISTS drafts_shop_updated ON drafts(shop_id, updated_at DESC)';
export const DRAFT_STATUSES = ['draft', 'pending_review', 'approved'];
export const DEFAULT_SHOP_NAME = 'Shop của tôi';
export const REAUTH_WINDOW = 600;
export const INVITE_TTL = 7 * 24 * 3600;
export const SHOP_HEADER = 'X-ShopPost-Shop';
const SHOP_ID = /^s_[A-Za-z0-9_-]{8,32}$/;
const USER_ID = /^[^\s]{1,256}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const now = () => Math.floor(Date.now() / 1000);
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomId = (prefix, size = 12) => prefix + b64url(crypto.getRandomValues(new Uint8Array(size)));
const hashHex = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
const cleanName = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 80) : '';

const ready = new WeakSet();
export async function ensureShopSchema(db) {
  if (ready.has(db)) return;
  await db.batch(SHOP_SCHEMA.map(sql => db.prepare(sql)));
  const { results } = await db.prepare('PRAGMA table_info(drafts)').all();
  const existing = new Set((results || []).map(column => column.name));
  for (const [name, ddl] of DRAFT_COLUMNS) {
    if (!existing.has(name)) await db.prepare(`ALTER TABLE drafts ADD COLUMN ${name} ${ddl}`).run();
  }
  await db.prepare(DRAFT_INDEX).run();
  ready.add(db);
}

// Nhật ký hệ thống: không bao giờ ghi nội dung bản nháp hay dữ liệu khách hàng vào detail.
export async function audit(db, { shopId = null, actor, action, target = null, detail = null }) {
  await db.prepare('INSERT INTO audit_log (shop_id, actor, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(shopId, actor, action, target, detail ? JSON.stringify(detail) : null, now()).run();
}

const membershipRow = row => row ? { role: row.role, can_publish: Number(row.can_publish) === 1 } : null;
const shopRow = row => ({ id: row.id, name: row.name, owner: row.owner, status: row.status, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) });
async function membershipOf(db, shopId, userId) {
  return db.prepare('SELECT s.id, s.name, s.owner, s.status, s.created_at, s.updated_at, m.role, m.can_publish FROM shop_members m JOIN shops s ON s.id = m.shop_id WHERE m.shop_id = ? AND m.user_id = ?').bind(shopId, userId).first();
}
async function defaultMembership(db, userId) {
  return db.prepare("SELECT s.id, s.name, s.owner, s.status, s.created_at, s.updated_at, m.role, m.can_publish FROM shop_members m JOIN shops s ON s.id = m.shop_id WHERE m.user_id = ? AND s.status = 'active' ORDER BY CASE WHEN m.role = 'owner' THEN 0 ELSE 1 END, m.created_at ASC, m.rowid ASC LIMIT 1").bind(userId).first();
}

async function createShop(db, name, owner, { auto = false } = {}) {
  const id = randomId('s_'), t = now();
  await db.batch([
    db.prepare('INSERT INTO shops (id, name, owner, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, name, owner, 'active', t, t),
    db.prepare('INSERT INTO shop_members (shop_id, user_id, role, can_publish, created_at, invited_by) VALUES (?, ?, ?, 1, ?, NULL)').bind(id, owner, 'owner', t),
    db.prepare('INSERT INTO audit_log (shop_id, actor, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, owner, 'shop.create', id, JSON.stringify({ auto }), t)
  ]);
  return id;
}

// Liên kết danh tính: cùng một email đã xác minh ở cả Access (claim email) lẫn đăng nhập email OTP
// thì danh tính email được thêm làm thành viên tương đương chủ shop vào shop cá nhân của danh tính Access. Không xóa gì.
async function linkIdentities(db, email) {
  const { results } = await db.prepare('SELECT owner, source FROM identity_links WHERE email = ?').bind(email).all();
  const accessOwners = results.filter(r => r.source === 'access').map(r => r.owner);
  const emailOwners = results.filter(r => r.source === 'email').map(r => r.owner);
  for (const accessOwner of accessOwners) {
    const shop = await db.prepare("SELECT id FROM shops WHERE owner = ? AND status != 'deleted' ORDER BY created_at ASC LIMIT 1").bind(accessOwner).first();
    if (!shop) continue;
    for (const emailOwner of emailOwners) {
      if (emailOwner === accessOwner) continue;
      const inserted = await db.prepare('INSERT OR IGNORE INTO shop_members (shop_id, user_id, role, can_publish, created_at, invited_by) VALUES (?, ?, ?, 1, ?, ?)').bind(shop.id, emailOwner, 'owner', now(), accessOwner).run();
      if (inserted.meta.changes === 1) await audit(db, { shopId: shop.id, actor: emailOwner, action: 'identity.link', target: accessOwner, detail: { source: 'email_verified', role: 'owner' } });
    }
  }
}

// Lần gọi đầu của người dùng chưa có shop: tạo "Shop của tôi" (họ là owner) và gán toàn bộ bản nháp cũ (shop_id NULL) vào đó.
export async function bootstrapUser(env, who) {
  const db = env.DB;
  await ensureShopSchema(db);
  const existing = await db.prepare('SELECT COUNT(*) AS n FROM shop_members WHERE user_id = ?').bind(who.owner).first();
  if (!existing || Number(existing.n) === 0) {
    const shopId = await createShop(db, DEFAULT_SHOP_NAME, who.owner, { auto: true });
    const adopted = await db.prepare("UPDATE drafts SET shop_id = ?, status = COALESCE(status, 'draft'), created_by = owner WHERE owner = ? AND shop_id IS NULL").bind(shopId, who.owner).run();
    if (adopted.meta.changes > 0) await audit(db, { shopId, actor: who.owner, action: 'drafts.adopt', target: shopId, detail: { count: adopted.meta.changes } });
  }
  if (who.email && who.emailVerified) {
    const source = who.via === 'access' ? 'access' : 'email';
    const t = now();
    const linked = await db.prepare('INSERT OR IGNORE INTO identity_links (owner, email, source, verified_at, created_at) VALUES (?, ?, ?, ?, ?)').bind(who.owner, who.email, source, t, t).run();
    if (linked.meta.changes === 1) await linkIdentities(db, who.email);
  }
}

// Ngữ cảnh shop cho MỌI yêu cầu dữ liệu: shop lấy từ header X-ShopPost-Shop, không có thì dùng shop mặc định của người dùng.
export async function resolveShop(env, who, request) {
  await bootstrapUser(env, who);
  const requested = request.headers.get(SHOP_HEADER);
  let row;
  if (requested !== null && requested !== '') {
    if (!SHOP_ID.test(requested)) return { error: 'Không tìm thấy shop hoặc bạn không phải thành viên.', status: 404, code: 'shop_not_found' };
    row = await membershipOf(env.DB, requested, who.owner);
    if (!row || row.status === 'deleted') return { error: 'Không tìm thấy shop hoặc bạn không phải thành viên.', status: 404, code: 'shop_not_found' };
    if (row.status !== 'active') return { error: 'Shop đang bị tạm ngưng. Liên hệ quản trị nền tảng để được hỗ trợ.', status: 403, code: 'shop_suspended' };
  } else {
    row = await defaultMembership(env.DB, who.owner);
    if (!row) return { error: 'Bạn chưa có shop nào đang hoạt động.', status: 403, code: 'no_active_shop' };
  }
  const membership = membershipRow(row);
  return { shop: shopRow(row), membership, permissions: allowedActions(membership), can: action => can(membership, action) };
}

export const freshSession = who => Number.isFinite(who?.authAt) && who.authAt > 0 && now() - who.authAt <= REAUTH_WINDOW;
const REAUTH = { error: 'Thao tác nhạy cảm cần đăng nhập lại trong 10 phút gần nhất. Hãy đăng xuất rồi đăng nhập lại và thử lại.', code: 'reauth_required' };
const FORBIDDEN = { error: 'Bạn không có quyền thực hiện thao tác này trong shop hiện tại.', code: 'forbidden' };
const NOT_FOUND = { error: 'Không tìm thấy shop hoặc bạn không phải thành viên.', code: 'shop_not_found' };

const shopView = (row, membership) => ({ ...shopRow(row), role: membership.role, roleLabel: ROLE_LABELS[membership.role], canPublish: membership.can_publish, permissions: allowedActions(membership) });

export async function writeLimit(env, owner) {
  try {
    const limit = await env.AI_RATE_LIMITER?.limit({ key: 'api-write:' + owner });
    if (!limit || typeof limit.success !== 'boolean') throw new Error('RATE_LIMIT_UNAVAILABLE');
    return limit.success ? null : { error: 'Quá nhiều yêu cầu. Vui lòng thử lại sau.', status: 429 };
  } catch { return { error: 'Dịch vụ giới hạn tần suất tạm thời không khả dụng.', status: 503 }; }
}

async function body(request, json, max = 8192) {
  try { return [await readJson(request, max), null]; }
  catch (error) {
    const messages = { TYPE: ['Cần gửi application/json.', 415], SIZE: ['Nội dung vượt giới hạn.', 413] };
    const [message, status] = messages[error.message] || ['JSON không hợp lệ.', 400];
    return [null, json({ error: message }, status)];
  }
}

// Bộ định tuyến /api/* và /invite/<token>. who = danh tính đã xác minh (owner, via, email, emailVerified, authAt).
export async function handleApi(request, env, who, json) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const db = env.DB;
  if (!db) return json({ error: 'Chưa gắn cơ sở dữ liệu.' }, 503);
  if (method !== 'GET' && method !== 'HEAD') {
    if (request.headers.get('Origin') !== url.origin) return json({ error: 'Chỉ cho phép ghi từ cùng origin.' }, 403);
    const limited = await writeLimit(env, who.owner);
    if (limited) return json({ error: limited.error }, limited.status, limited.status === 429 ? { 'Retry-After': '60' } : {});
  }
  try {
    await bootstrapUser(env, who);
    const admin = isPlatformAdmin(env, who);
    let m;
    if (path === '/api/shops') {
      if (method === 'GET') {
        const { results } = await db.prepare("SELECT s.id, s.name, s.owner, s.status, s.created_at, s.updated_at, m.role, m.can_publish, (SELECT COUNT(*) FROM shop_members x WHERE x.shop_id = s.id) AS member_count FROM shop_members m JOIN shops s ON s.id = m.shop_id WHERE m.user_id = ? AND s.status != 'deleted' ORDER BY CASE WHEN m.role = 'owner' THEN 0 ELSE 1 END, m.created_at ASC, m.rowid ASC").bind(who.owner).all();
        const fallback = await defaultMembership(db, who.owner);
        return json({ shops: results.map(r => ({ ...shopView(r, membershipRow(r)), memberCount: Number(r.member_count) })), defaultShopId: fallback ? fallback.id : null, admin, roles: ROLE_LABELS });
      }
      if (method === 'POST') {
        const [data, bad] = await body(request, json); if (bad) return bad;
        const name = cleanName(data.name);
        if (!name) return json({ error: 'Tên shop không hợp lệ (1–80 ký tự).' }, 400);
        const count = await db.prepare("SELECT COUNT(*) AS n FROM shops WHERE owner = ? AND status != 'deleted'").bind(who.owner).first();
        if (Number(count.n) >= 20) return json({ error: 'Mỗi tài khoản sở hữu tối đa 20 shop.' }, 409);
        const id = await createShop(db, name, who.owner);
        const row = await membershipOf(db, id, who.owner);
        return json({ shop: shopView(row, membershipRow(row)) }, 201);
      }
      return json({ error: 'Chỉ hỗ trợ GET hoặc POST.' }, 405, { Allow: 'GET, POST' });
    }
    if ((m = /^\/api\/invites\/([A-Za-z0-9_-]{43})(\/accept)?$/.exec(path))) {
      const tokenHash = await hashHex(m[1]);
      const invite = await db.prepare('SELECT i.*, s.name AS shop_name, s.status AS shop_status FROM shop_invites i JOIN shops s ON s.id = i.shop_id WHERE i.token_hash = ?').bind(tokenHash).first();
      if (!invite || invite.shop_status === 'deleted') return json({ error: 'Lời mời không tồn tại hoặc đã bị xóa.', code: 'invite_not_found' }, 404);
      const state = invite.revoked_at ? 'revoked' : invite.accepted_at ? 'accepted' : Number(invite.expires_at) <= now() ? 'expired' : invite.shop_status !== 'active' ? 'suspended' : 'pending';
      const info = { shop: { id: invite.shop_id, name: invite.shop_name }, role: invite.role, roleLabel: ROLE_LABELS[invite.role], email: invite.email || null, expiresAt: Number(invite.expires_at), state };
      if (!m[2]) return method === 'GET' ? json({ invite: info }) : json({ error: 'Chỉ hỗ trợ GET.' }, 405, { Allow: 'GET' });
      if (method !== 'POST') return json({ error: 'Chỉ hỗ trợ POST.' }, 405, { Allow: 'POST' });
      const reasons = { revoked: 'Lời mời đã bị thu hồi.', accepted: 'Lời mời đã được sử dụng.', expired: 'Lời mời đã hết hạn.', suspended: 'Shop đang bị tạm ngưng.' };
      if (state !== 'pending') return json({ error: reasons[state], code: 'invite_' + state, invite: info }, 410);
      const already = await db.prepare('SELECT role FROM shop_members WHERE shop_id = ? AND user_id = ?').bind(invite.shop_id, who.owner).first();
      const t = now();
      const claimed = await db.prepare('UPDATE shop_invites SET accepted_by = ?, accepted_at = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL').bind(who.owner, t, invite.id).run();
      if (claimed.meta.changes !== 1) return json({ error: 'Lời mời đã được sử dụng.', code: 'invite_accepted' }, 410);
      if (!already) {
        await db.prepare('INSERT INTO shop_members (shop_id, user_id, role, can_publish, created_at, invited_by) VALUES (?, ?, ?, 0, ?, ?)').bind(invite.shop_id, who.owner, invite.role, t, invite.created_by).run();
      }
      await audit(db, { shopId: invite.shop_id, actor: who.owner, action: 'members.join', target: who.owner, detail: { inviteId: invite.id, role: already ? already.role : invite.role, alreadyMember: Boolean(already) } });
      const row = await membershipOf(db, invite.shop_id, who.owner);
      return json({ joined: !already, alreadyMember: Boolean(already), shop: shopView(row, membershipRow(row)) });
    }
    if (path.startsWith('/api/admin/')) {
      if (!admin) return json({ error: 'Chỉ quản trị nền tảng mới truy cập được.', code: 'forbidden' }, 403);
      if (path === '/api/admin/overview' && method === 'GET') {
        const t = now();
        const shops = await db.prepare('SELECT COUNT(*) AS n FROM shops').first();
        const users = await db.prepare('SELECT COUNT(*) AS n FROM (SELECT owner FROM auth_identities UNION SELECT user_id FROM shop_members)').first();
        const sessions = await db.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE expires_at > ?').bind(t).first();
        const { results } = await db.prepare('SELECT s.id, s.name, s.status, s.created_at, (SELECT COUNT(*) FROM shop_members x WHERE x.shop_id = s.id) AS member_count FROM shops s ORDER BY s.created_at DESC LIMIT 200').all();
        await audit(db, { actor: who.owner, action: 'admin.overview' });
        // Không có nội dung bản nháp hay dữ liệu khách hàng trong phản hồi này.
        return json({ counts: { shops: Number(shops.n), users: Number(users.n), sessions: Number(sessions.n) }, shops: results.map(r => ({ id: r.id, name: r.name, status: r.status, memberCount: Number(r.member_count), createdAt: Number(r.created_at) })) });
      }
      if (path === '/api/admin/audit' && method === 'GET') {
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 100;
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) return json({ error: 'Giới hạn phải từ 1 đến 500.' }, 400);
        const { results } = await db.prepare('SELECT id, shop_id, actor, action, target, detail, created_at FROM audit_log ORDER BY id DESC LIMIT ?').bind(limit).all();
        return json({ entries: results.map(r => ({ id: Number(r.id), shopId: r.shop_id, actor: r.actor, action: r.action, target: r.target, detail: r.detail ? JSON.parse(r.detail) : null, createdAt: Number(r.created_at) })) });
      }
      if ((m = /^\/api\/admin\/shops\/(s_[A-Za-z0-9_-]{8,32})$/.exec(path)) && method === 'PATCH') {
        const [data, bad] = await body(request, json); if (bad) return bad;
        if (!['active', 'suspended'].includes(data.status)) return json({ error: 'Trạng thái phải là active hoặc suspended.' }, 400);
        const res = await db.prepare("UPDATE shops SET status = ?, updated_at = ? WHERE id = ? AND status != 'deleted'").bind(data.status, now(), m[1]).run();
        if (res.meta.changes !== 1) return json({ error: 'Không tìm thấy shop.' }, 404);
        await audit(db, { shopId: m[1], actor: who.owner, action: 'admin.shop_status', target: m[1], detail: { status: data.status } });
        return json({ ok: true, id: m[1], status: data.status });
      }
      return json({ error: 'Không tìm thấy endpoint quản trị.' }, 404);
    }
    m = /^\/api\/shops\/(s_[A-Za-z0-9_-]{8,32})(?:\/(members|invites|transfer)(?:\/([^/]{1,256}))?)?$/.exec(path);
    if (!m) return json({ error: 'Không tìm thấy endpoint.' }, 404);
    const [, shopId, section, sub] = m;
    const row = await membershipOf(db, shopId, who.owner);
    if (!row || row.status === 'deleted') return json(NOT_FOUND, 404);
    const membership = membershipRow(row);
    const allow = action => can(membership, action);
    const active = row.status === 'active';
    const suspended = () => json({ error: 'Shop đang bị tạm ngưng. Liên hệ quản trị nền tảng để được hỗ trợ.', code: 'shop_suspended' }, 403);
    if (!section) {
      if (method === 'GET') {
        const count = await db.prepare('SELECT COUNT(*) AS n FROM shop_members WHERE shop_id = ?').bind(shopId).first();
        return json({ shop: { ...shopView(row, membership), memberCount: Number(count.n) } });
      }
      if (method === 'PATCH') {
        if (!allow('shop.update')) return json(FORBIDDEN, 403);
        if (!active) return suspended();
        const [data, bad] = await body(request, json); if (bad) return bad;
        const name = cleanName(data.name);
        if (!name) return json({ error: 'Tên shop không hợp lệ (1–80 ký tự).' }, 400);
        await db.prepare('UPDATE shops SET name = ?, updated_at = ? WHERE id = ?').bind(name, now(), shopId).run();
        await audit(db, { shopId, actor: who.owner, action: 'shop.update', target: shopId, detail: { name } });
        const fresh = await membershipOf(db, shopId, who.owner);
        return json({ shop: shopView(fresh, membership) });
      }
      if (method === 'DELETE') {
        if (!allow('shop.delete')) return json(FORBIDDEN, 403);
        if (!freshSession(who)) return json(REAUTH, 403);
        await db.prepare("UPDATE shops SET status = 'deleted', updated_at = ? WHERE id = ?").bind(now(), shopId).run();
        await audit(db, { shopId, actor: who.owner, action: 'shop.delete', target: shopId });
        return json({ ok: true, id: shopId, status: 'deleted' });
      }
      return json({ error: 'Chỉ hỗ trợ GET, PATCH hoặc DELETE.' }, 405, { Allow: 'GET, PATCH, DELETE' });
    }
    if (section === 'transfer') {
      if (method !== 'POST' || sub) return json({ error: 'Chỉ hỗ trợ POST.' }, 405, { Allow: 'POST' });
      if (!allow('shop.transfer')) return json(FORBIDDEN, 403);
      if (!active) return suspended();
      if (!freshSession(who)) return json(REAUTH, 403);
      const [data, bad] = await body(request, json); if (bad) return bad;
      const to = typeof data.to === 'string' ? data.to : '';
      if (!USER_ID.test(to) || to === who.owner) return json({ error: 'Chọn một thành viên khác để nhận quyền sở hữu.' }, 400);
      const target = await db.prepare('SELECT role FROM shop_members WHERE shop_id = ? AND user_id = ?').bind(shopId, to).first();
      if (!target) return json({ error: 'Người nhận phải là thành viên của shop.' }, 404);
      const t = now();
      await db.batch([
        db.prepare("UPDATE shop_members SET role = 'owner', can_publish = 1 WHERE shop_id = ? AND user_id = ?").bind(shopId, to),
        db.prepare("UPDATE shop_members SET role = 'manager' WHERE shop_id = ? AND user_id = ?").bind(shopId, who.owner),
        db.prepare('UPDATE shops SET owner = ?, updated_at = ? WHERE id = ?').bind(to, t, shopId),
        db.prepare('INSERT INTO audit_log (shop_id, actor, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(shopId, who.owner, 'shop.transfer', to, JSON.stringify({ from: who.owner, previousRole: target.role }), t)
      ]);
      const fresh = await membershipOf(db, shopId, who.owner);
      return json({ ok: true, shop: shopView(fresh, membershipRow(fresh)) });
    }
    if (section === 'members') {
      if (!sub && method === 'GET') {
        if (!allow('members.view')) return json(FORBIDDEN, 403);
        const { results } = await db.prepare('SELECT m.user_id, m.role, m.can_publish, m.created_at, m.invited_by, i.display_name, i.provider FROM shop_members m LEFT JOIN auth_identities i ON i.owner = m.user_id WHERE m.shop_id = ? ORDER BY CASE m.role WHEN \'owner\' THEN 0 WHEN \'manager\' THEN 1 WHEN \'content\' THEN 2 WHEN \'support\' THEN 3 ELSE 4 END, m.created_at ASC').bind(shopId).all();
        return json({ members: results.map(r => ({ userId: r.user_id, name: r.display_name || '', provider: r.provider || (r.user_id.includes(':') ? r.user_id.split(':')[0] : 'access'), role: r.role, roleLabel: ROLE_LABELS[r.role], canPublish: Number(r.can_publish) === 1, createdAt: Number(r.created_at), invitedBy: r.invited_by || null, you: r.user_id === who.owner })) });
      }
      if (!sub) return json({ error: 'Chỉ hỗ trợ GET.' }, 405, { Allow: 'GET' });
      const userId = decodeURIComponent(sub);
      const target = await db.prepare('SELECT role, can_publish FROM shop_members WHERE shop_id = ? AND user_id = ?').bind(shopId, userId).first();
      if (!target) return json({ error: 'Không tìm thấy thành viên.' }, 404);
      const ownerCount = async () => Number((await db.prepare("SELECT COUNT(*) AS n FROM shop_members WHERE shop_id = ? AND role = 'owner'").bind(shopId).first()).n);
      if (method === 'PATCH') {
        if (!allow('members.update_role')) return json(FORBIDDEN, 403);
        if (!active) return suspended();
        const [data, bad] = await body(request, json); if (bad) return bad;
        const role = data.role === undefined ? target.role : data.role;
        if (!isRole(role)) return json({ error: 'Vai trò không hợp lệ.' }, 400);
        const canPublish = data.canPublish === undefined ? Number(target.can_publish) === 1 : data.canPublish === true;
        if (target.role === 'owner' && role !== 'owner' && await ownerCount() <= 1) return json({ error: 'Không thể hạ vai trò chủ shop cuối cùng. Hãy chuyển quyền sở hữu trước.', code: 'last_owner' }, 409);
        await db.prepare('UPDATE shop_members SET role = ?, can_publish = ? WHERE shop_id = ? AND user_id = ?').bind(role, role === 'owner' ? 1 : (canPublish ? 1 : 0), shopId, userId).run();
        await audit(db, { shopId, actor: who.owner, action: 'members.update_role', target: userId, detail: { from: target.role, to: role, canPublish: role === 'owner' ? true : canPublish } });
        return json({ ok: true, userId, role, canPublish: role === 'owner' ? true : canPublish });
      }
      if (method === 'DELETE') {
        const self = userId === who.owner;
        if (!self && !allow('members.remove')) return json(FORBIDDEN, 403);
        if (target.role === 'owner' && await ownerCount() <= 1) return json({ error: 'Không thể xóa chủ shop cuối cùng. Hãy chuyển quyền sở hữu trước.', code: 'last_owner' }, 409);
        await db.prepare('DELETE FROM shop_members WHERE shop_id = ? AND user_id = ?').bind(shopId, userId).run();
        await audit(db, { shopId, actor: who.owner, action: self ? 'members.leave' : 'members.remove', target: userId, detail: { role: target.role } });
        return json({ ok: true, userId });
      }
      return json({ error: 'Chỉ hỗ trợ PATCH hoặc DELETE.' }, 405, { Allow: 'PATCH, DELETE' });
    }
    if (section === 'invites') {
      if (!allow('members.invite')) return json(FORBIDDEN, 403);
      if (!sub && method === 'GET') {
        const { results } = await db.prepare('SELECT id, email, role, expires_at, created_by, created_at FROM shop_invites WHERE shop_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC').bind(shopId, now()).all();
        return json({ invites: results.map(r => ({ id: r.id, email: r.email || null, role: r.role, roleLabel: ROLE_LABELS[r.role], expiresAt: Number(r.expires_at), createdBy: r.created_by, createdAt: Number(r.created_at) })) });
      }
      if (!sub && method === 'POST') {
        if (!active) return suspended();
        const [data, bad] = await body(request, json); if (bad) return bad;
        if (!isRole(data.role) || data.role === 'owner') return json({ error: 'Vai trò mời phải là manager, content, support hoặc viewer. Quyền sở hữu chỉ chuyển qua "Chuyển quyền sở hữu".' }, 400);
        let email = null;
        if (data.email !== undefined && data.email !== null && data.email !== '') {
          email = normalizeEmail(data.email);
          if (!email) return json({ error: 'Email không hợp lệ.' }, 400);
        }
        const pending = await db.prepare('SELECT COUNT(*) AS n FROM shop_invites WHERE shop_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?').bind(shopId, now()).first();
        if (Number(pending.n) >= 50) return json({ error: 'Shop đang có quá nhiều lời mời chờ. Hãy thu hồi bớt trước.' }, 409);
        const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
        const id = randomId('inv_'), t = now();
        await db.prepare('INSERT INTO shop_invites (id, shop_id, email, role, token_hash, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, shopId, email, data.role, await hashHex(token), t + INVITE_TTL, who.owner, t).run();
        const link = url.origin + '/invite/' + token;
        let emailed = false;
        if (email && emailConfigured(env)) emailed = await sendEmail(env, { to: email, ...inviteEmail({ shopName: row.name, roleLabel: ROLE_LABELS[data.role], link }) });
        await audit(db, { shopId, actor: who.owner, action: 'members.invite', target: id, detail: { role: data.role, hasEmail: Boolean(email), emailed } });
        return json({ invite: { id, email, role: data.role, roleLabel: ROLE_LABELS[data.role], expiresAt: t + INVITE_TTL }, link, emailed }, 201);
      }
      if (sub && method === 'DELETE') {
        if (!/^inv_[A-Za-z0-9_-]{8,32}$/.test(sub)) return json({ error: 'Không tìm thấy lời mời.' }, 404);
        const res = await db.prepare('UPDATE shop_invites SET revoked_at = ? WHERE id = ? AND shop_id = ? AND accepted_at IS NULL AND revoked_at IS NULL').bind(now(), sub, shopId).run();
        if (res.meta.changes !== 1) return json({ error: 'Không tìm thấy lời mời đang chờ.' }, 404);
        await audit(db, { shopId, actor: who.owner, action: 'members.invite_revoke', target: sub });
        return json({ ok: true, id: sub });
      }
      return json({ error: 'Phương thức không được hỗ trợ.' }, 405, { Allow: sub ? 'DELETE' : 'GET, POST' });
    }
    return json({ error: 'Không tìm thấy endpoint.' }, 404);
  } catch (error) {
    console.error('api_failed', JSON.stringify({ path, code: error && error.message ? String(error.message).slice(0, 80) : 'unknown' }));
    return json({ error: 'Không thể truy cập dữ liệu shop lúc này. Vui lòng thử lại sau.' }, 503);
  }
}

export const INVITE_PATH = /^\/invite\/([A-Za-z0-9_-]{43})$/;
export const isInviteToken = value => TOKEN.test(value || '');
export { ROLES, ROLE_LABELS };
