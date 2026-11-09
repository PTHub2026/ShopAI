import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
const worker = (await import(new URL('../src/worker.js', import.meta.url))).default;
const { SESSION_COOKIE } = await import(new URL('../src/auth.js', import.meta.url));
const { ACTIONS, ROLES, ROLE_LABELS, allowedActions, can, isPlatformAdmin } = await import(new URL('../src/permissions.js', import.meta.url));
const { DRAFT_COLUMNS, DRAFT_INDEX, SHOP_SCHEMA, ensureShopSchema } = await import(new URL('../src/shops.js', import.meta.url));

const BASE = 'https://shoppost.example';
const issuer = 'https://test-team.cloudflareaccess.com';
const sha = text => createHash('sha256').update(text).digest('hex');
const now = () => Math.floor(Date.now() / 1000);

// SQL và schema thật (node:sqlite); chỉ nạp 0001 + 0002 — bảng shop phải do Worker tự tạo lúc chạy (ensureShopSchema).
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_drafts.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0002_auth.sql', import.meta.url), 'utf8'));
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
const plain = r => r ? { ...r } : null;
const row = (db, sql, ...params) => plain(db.sqlite.prepare(sql).get(...params));
const rows = (db, sql, ...params) => db.sqlite.prepare(sql).all(...params).map(plain);

function env(overrides = {}) {
  return {
    ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com', ACCESS_AUD: 'test-audience', PLATFORM_ADMIN_EMAILS: 'ct@pthub.vn',
    AI: { run: async () => ({ response: 'Nội dung AI' }) }, AI_RATE_LIMITER: { limit: async () => ({ success: true }) }, DB: database(),
    FRONTEND_HTML: '<html><head></head><body>Ứng dụng Shoppost</body></html>', LOGIN_HTML: '<html><head></head><body>Đăng nhập Shoppost</body></html>', ...overrides
  };
}
// Phiên đăng nhập được chèn thẳng vào auth_sessions (đúng cách Worker tra cứu: SHA-256 của token trong cookie).
let seq = 0;
function session(e, owner, { provider = owner.split(':')[0], createdAt = now(), name = '' } = {}) {
  const token = Buffer.from(String(++seq).padStart(16, '0') + owner.padEnd(16, '#')).toString('base64url').slice(0, 43).padEnd(43, 'A');
  e.DB.sqlite.prepare('INSERT INTO auth_identities (owner, provider, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner) DO NOTHING').run(owner, provider, name, createdAt, createdAt);
  e.DB.sqlite.prepare('INSERT INTO auth_sessions (token_hash, owner, provider, display_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(sha(token), owner, provider, name, createdAt, createdAt + 86400);
  return { Cookie: `${SESSION_COOKIE}=${token}` };
}
const call = (e, path, { method = 'GET', body, headers = {}, shop } = {}) => worker.fetch(new Request(BASE + path, {
  method,
  headers: { ...(method !== 'GET' ? { Origin: BASE, 'Content-Type': 'application/json' } : {}), ...(shop ? { 'X-ShopPost-Shop': shop } : {}), ...headers },
  ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {})
}), e);
const json = async response => ({ status: response.status, body: await response.json() });
const draft = (id, content = 'Nội dung bản nháp') => ({ id, type: 'post', content, channels: [], status: 'draft', media: [], assets: [], custom: {} });

// Access JWT thật (RS256) có claim email để kiểm tra quản trị nền tảng và liên kết danh tính.
const { subtle } = webcrypto;
const pair = await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await subtle.exportKey('jwk', pair.publicKey), kid: 'test-key', use: 'sig', alg: 'RS256' };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
async function accessJwt(claims) {
  const head = encode({ alg: 'RS256', kid: 'test-key' }) + '.' + encode({ iss: issuer, aud: ['test-audience'], exp: now() + 3600, iat: now(), ...claims });
  return { 'Cf-Access-Jwt-Assertion': head + '.' + Buffer.from(await subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, Buffer.from(head))).toString('base64url') };
}
const realFetch = globalThis.fetch;
async function withCerts(callback) {
  globalThis.fetch = async input => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === issuer + '/cdn-cgi/access/certs') return Response.json({ keys: [jwk] });
    throw new Error('Gọi mạng ngoài dự kiến: ' + url);
  };
  try { return await callback(); } finally { globalThis.fetch = realFetch; }
}

test('Migration 0003_shops_roles.sql khớp đúng schema runtime và không làm mất cột cũ của drafts', async () => {
  const norm = sql => sql.replace(/\s+/g, ' ').trim();
  const file = readFileSync(new URL('../migrations/0003_shops_roles.sql', import.meta.url), 'utf8').split('\n').filter(line => !line.startsWith('--')).join('\n');
  const expected = [...SHOP_SCHEMA, ...DRAFT_COLUMNS.map(([name, ddl]) => `ALTER TABLE drafts ADD COLUMN ${name} ${ddl}`), DRAFT_INDEX];
  assert.deepEqual(file.split(';').map(norm).filter(Boolean), expected.map(norm));
  // Áp file migration lên D1 chỉ có 0001 và để Worker tự tạo schema lúc chạy phải cho cùng kết quả.
  const byFile = new DatabaseSync(':memory:');
  byFile.exec(readFileSync(new URL('../migrations/0001_drafts.sql', import.meta.url), 'utf8'));
  byFile.exec(readFileSync(new URL('../migrations/0003_shops_roles.sql', import.meta.url), 'utf8'));
  const runtime = database();
  await ensureShopSchema(runtime); await ensureShopSchema(runtime); // gọi lại an toàn
  const describe = sqlite => ({
    tables: sqlite.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'auth_%' ORDER BY name").all().map(r => r.name),
    drafts: sqlite.prepare('PRAGMA table_info(drafts)').all().map(c => [c.name, c.type, c.notnull, c.dflt_value])
  });
  assert.deepEqual(describe(runtime.sqlite), describe(byFile));
  assert.deepEqual(describe(byFile).drafts.slice(0, 5).map(c => c[0]), ['owner', 'id', 'payload', 'revision', 'updated_at']);
  // Worker đã chạy trước rồi mới áp file: các CREATE chạy lại an toàn, chỉ ALTER báo trùng cột.
  for (const sql of SHOP_SCHEMA) runtime.sqlite.exec(sql);
  assert.throws(() => runtime.sqlite.exec('ALTER TABLE drafts ADD COLUMN shop_id TEXT'), /duplicate column/);
  byFile.close(); runtime.sqlite.close();
});

test('Ma trận phân quyền: từng vai trò × hành động, cờ can_publish và quản trị nền tảng', () => {
  const shopActions = ACTIONS.filter(a => !a.startsWith('admin.'));
  const expected = {
    owner: shopActions,
    manager: ['shop.view', 'shop.update', 'members.view', 'channels.view', 'channels.configure_token', 'channels.operate', 'drafts.view', 'drafts.create', 'drafts.edit_own', 'drafts.edit_any', 'drafts.submit', 'drafts.approve', 'drafts.publish', 'drafts.delete', 'ai.use', 'conversations.view_assigned', 'conversations.reply', 'conversations.assign', 'reports.view'],
    content: ['shop.view', 'members.view', 'channels.view', 'drafts.view', 'drafts.create', 'drafts.edit_own', 'drafts.submit', 'ai.use'],
    support: ['shop.view', 'members.view', 'channels.view', 'ai.use', 'conversations.view_assigned', 'conversations.reply'],
    viewer: ['shop.view', 'members.view', 'channels.view', 'drafts.view', 'reports.view']
  };
  assert.deepEqual(ROLES, Object.keys(expected));
  assert.deepEqual(Object.values(ROLE_LABELS), ['Chủ shop', 'Quản lý shop', 'Nhân viên nội dung', 'Nhân viên CSKH', 'Chỉ xem']);
  for (const role of ROLES) {
    assert.deepEqual(allowedActions({ role, can_publish: false }), expected[role], role);
    for (const action of ACTIONS) assert.equal(can({ role, can_publish: false }, action), expected[role].includes(action), role + ' × ' + action);
    for (const action of ['admin.overview', 'admin.shops', 'admin.audit']) assert.equal(can({ role, can_publish: true }, action), false, role + ' không có ' + action);
  }
  // Ràng buộc nghiệp vụ nổi bật của từng vai trò.
  for (const action of ['shop.transfer', 'shop.delete', 'members.invite', 'members.update_role', 'members.remove']) assert.equal(can({ role: 'manager' }, action), false, 'manager không được ' + action);
  for (const action of ['drafts.approve', 'drafts.publish', 'drafts.edit_any', 'drafts.delete']) assert.equal(can({ role: 'content' }, action), false, 'content không được ' + action);
  assert.deepEqual(allowedActions({ role: 'content', can_publish: true }).filter(a => !expected.content.includes(a)), ['drafts.approve', 'drafts.publish']);
  assert.equal(can({ role: 'viewer', can_publish: true }, 'drafts.approve'), false, 'can_publish chỉ có tác dụng với content');
  for (const action of ['drafts.view', 'drafts.create', 'channels.configure_token', 'members.invite', 'drafts.publish']) assert.equal(can({ role: 'support' }, action), false, 'support không được ' + action);
  for (const action of ['drafts.create', 'drafts.edit_own', 'drafts.submit', 'ai.use']) assert.equal(can({ role: 'viewer' }, action), false, 'viewer không được ' + action);
  assert.equal(can(null, 'shop.view'), false); assert.equal(can({ role: 'admin' }, 'shop.view'), false); assert.equal(can({ role: 'owner' }, 'khong.co'), false);
  const e = { PLATFORM_ADMIN_EMAILS: ' CT@pthub.vn , sai-dinh-dang ' };
  assert.equal(isPlatformAdmin(e, { email: 'ct@pthub.vn', emailVerified: true }), true);
  assert.equal(isPlatformAdmin(e, { email: 'ct@pthub.vn', emailVerified: false }), false);
  assert.equal(isPlatformAdmin(e, { email: 'khac@pthub.vn', emailVerified: true }), false);
  assert.equal(isPlatformAdmin({}, { email: 'ct@pthub.vn', emailVerified: true }), false);
});

test('Dữ liệu cũ: lần gọi đầu tạo "Shop của tôi", gán toàn bộ bản nháp cũ vào shop đó, không mất bản nháp', async () => {
  const e = env();
  const insert = e.DB.sqlite.prepare('INSERT INTO drafts (owner, id, payload, revision, updated_at) VALUES (?, ?, ?, ?, ?)');
  for (const id of ['cu-1', 'cu-2', 'cu-3']) insert.run('user-a', id, JSON.stringify(draft(id)), 2, 1000);
  insert.run('user-b', 'cua-b', JSON.stringify(draft('cua-b')), 1, 1000);
  await withCerts(async () => {
    const first = await json(await call(e, '/session', { headers: await accessJwt({ sub: 'user-a' }) }));
    assert.equal(first.status, 200);
    assert.equal(first.body.shop.name, 'Shop của tôi'); assert.equal(first.body.shop.role, 'owner'); assert.equal(first.body.admin, false);
    assert.ok(first.body.shop.permissions.includes('shop.transfer'));
    const shopId = first.body.shop.id;
    assert.deepEqual(rows(e.DB, 'SELECT id, status, created_by FROM drafts WHERE owner = ? AND shop_id = ? ORDER BY id', 'user-a', shopId), [{ id: 'cu-1', status: 'draft', created_by: 'user-a' }, { id: 'cu-2', status: 'draft', created_by: 'user-a' }, { id: 'cu-3', status: 'draft', created_by: 'user-a' }]);
    assert.equal(row(e.DB, 'SELECT shop_id FROM drafts WHERE id = ?', 'cua-b').shop_id, null, 'bản nháp của người khác không bị gán');
    assert.equal(row(e.DB, 'SELECT COUNT(*) AS n FROM drafts').n, 4, 'không mất bản nháp nào');
    const list = await json(await call(e, '/storage/drafts', { headers: await accessJwt({ sub: 'user-a' }) }));
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.drafts.map(d => d.draft.id).sort(), ['cu-1', 'cu-2', 'cu-3']);
    assert.equal(list.body.drafts[0].revision, 2, 'giữ nguyên revision cũ');
    // Gọi lần hai không tạo thêm shop.
    await call(e, '/session', { headers: await accessJwt({ sub: 'user-a' }) });
    assert.equal(row(e.DB, 'SELECT COUNT(*) AS n FROM shops').n, 1);
    assert.equal(row(e.DB, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'drafts.adopt'").n, 1);
  });
});

test('Liên kết danh tính: email đã xác minh ở cả Access lẫn OTP thì danh tính email thấy dữ liệu cũ; có ghi audit', async () => {
  const e = env();
  e.DB.sqlite.prepare('INSERT INTO drafts (owner, id, payload, revision, updated_at) VALUES (?, ?, ?, ?, ?)').run('access-sub', 'cu-1', JSON.stringify(draft('cu-1')), 1, 1000);
  const otp = session(e, 'email:ct@pthub.vn');
  const viaOtp = await json(await call(e, '/session', { headers: otp }));
  assert.equal(viaOtp.body.admin, true, 'email trong PLATFORM_ADMIN_EMAILS là quản trị nền tảng');
  const own = viaOtp.body.shop.id;
  await withCerts(async () => {
    const access = await accessJwt({ sub: 'access-sub', email: 'CT@pthub.vn' });
    const viaAccess = await json(await call(e, '/session', { headers: access }));
    assert.equal(viaAccess.body.admin, true);
    const legacy = viaAccess.body.shop.id;
    assert.notEqual(legacy, own);
    assert.deepEqual(row(e.DB, 'SELECT role, can_publish FROM shop_members WHERE shop_id = ? AND user_id = ?', legacy, 'email:ct@pthub.vn'), { role: 'owner', can_publish: 1 });
    assert.equal(row(e.DB, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'identity.link' AND actor = 'email:ct@pthub.vn' AND target = 'access-sub'").n, 1);
  });
  // Danh tính email chọn shop cũ qua header và đọc được bản nháp cũ.
  const list = await json(await call(e, '/storage/drafts', { headers: otp, shop: row(e.DB, "SELECT id FROM shops WHERE owner = 'access-sub'").id }));
  assert.equal(list.status, 200); assert.deepEqual(list.body.drafts.map(d => d.draft.id), ['cu-1']);
  // Access không có claim email, hoặc email khác, thì không liên kết.
  await withCerts(async () => {
    await call(e, '/session', { headers: await accessJwt({ sub: 'access-khac', email: 'khac@pthub.vn' }) });
    await call(e, '/session', { headers: await accessJwt({ sub: 'access-khong-email' }) });
  });
  assert.equal(rows(e.DB, "SELECT shop_id FROM shop_members WHERE user_id = 'email:ct@pthub.vn'").length, 2);
});

test('Không phải thành viên bị chặn; shop bị tạm ngưng/xóa không truy cập được; thiếu shop mặc định trả lỗi rõ', async () => {
  const e = env();
  const alice = session(e, 'email:alice@shop.vn'), bob = session(e, 'fb:200');
  const a = (await json(await call(e, '/session', { headers: alice }))).body.shop.id;
  await call(e, '/session', { headers: bob });
  assert.equal((await call(e, '/storage/drafts', { headers: bob, shop: a })).status, 404);
  assert.equal((await call(e, '/storage/drafts/x', { method: 'PUT', headers: bob, shop: a, body: { draft: draft('x'), revision: 0 } })).status, 404);
  assert.equal((await call(e, '/api/shops/' + a, { headers: bob })).status, 404);
  assert.equal((await call(e, '/api/shops/' + a + '/members', { headers: bob })).status, 404);
  assert.equal((await call(e, '/api/shops/' + a + '/invites', { method: 'POST', headers: bob, body: { role: 'viewer' } })).status, 404);
  assert.equal((await call(e, '/ai', { method: 'POST', headers: bob, shop: a, body: { task: 'generate', topic: 'x' } })).status, 404);
  assert.equal((await call(e, '/storage/drafts', { headers: bob, shop: 'khong-hop-le' })).status, 404);
  assert.equal((await call(e, '/api/shops', { headers: {} })).status, 401, 'chưa đăng nhập');
  assert.equal((await call(e, '/api/shops', { method: 'POST', headers: { ...alice, Origin: 'https://evil.example' }, body: { name: 'X' } })).status, 403);
  // Tạm ngưng rồi xóa mềm: thành viên cũng không vào được.
  e.DB.sqlite.prepare("UPDATE shops SET status = 'suspended' WHERE id = ?").run(a);
  const suspended = await json(await call(e, '/storage/drafts', { headers: alice, shop: a }));
  assert.equal(suspended.status, 403); assert.equal(suspended.body.code, 'shop_suspended');
  assert.equal((await json(await call(e, '/session', { headers: alice }))).body.shopError.code, 'no_active_shop');
  e.DB.sqlite.prepare("UPDATE shops SET status = 'deleted' WHERE id = ?").run(a);
  assert.equal((await call(e, '/storage/drafts', { headers: alice, shop: a })).status, 404);
  assert.equal((await call(e, '/api/shops/' + a, { headers: alice })).status, 404);
  assert.equal((await json(await call(e, '/api/shops', { headers: alice }))).body.shops.length, 0);
});

// Dựng shop có đủ vai trò: owner mời từng người qua link mời, người được mời chấp nhận.
async function team(e) {
  const owner = session(e, 'email:owner@shop.vn', { name: 'Chủ' });
  const shopId = (await json(await call(e, '/api/shops', { method: 'POST', headers: owner, body: { name: 'Shop Kiểm Thử' } }))).body.shop.id;
  const members = { owner };
  for (const role of ['manager', 'content', 'support', 'viewer']) {
    members[role] = session(e, role === 'content' ? 'zalo:' + role : 'fb:' + role, { name: 'NV ' + role });
    const invite = await json(await call(e, '/api/shops/' + shopId + '/invites', { method: 'POST', headers: owner, body: { role } }));
    assert.equal(invite.status, 201, JSON.stringify(invite.body));
    const token = invite.body.link.split('/invite/')[1];
    const accept = await json(await call(e, '/api/invites/' + token + '/accept', { method: 'POST', headers: members[role], body: {} }));
    assert.equal(accept.status, 200, JSON.stringify(accept.body)); assert.equal(accept.body.shop.role, role);
  }
  return { shopId, ...members };
}

test('Bản nháp theo vai trò: content không duyệt được, viewer không sửa được, support không đọc được, owner/manager duyệt', async () => {
  const e = env();
  const t = await team(e);
  const put = (who, id, revision = 0, content) => call(e, '/storage/drafts/' + id, { method: 'PUT', headers: who, shop: t.shopId, body: { draft: draft(id, content), revision } });
  const status = (who, id, body) => call(e, '/storage/drafts/' + id + '/status', { method: 'POST', headers: who, shop: t.shopId, body });
  const created = await json(await put(t.content, 'bai-1'));
  assert.equal(created.status, 200); assert.equal(created.body.status, 'draft'); assert.equal(created.body.createdBy, 'zalo:content');
  // content: gửi duyệt được, không tự duyệt.
  assert.equal((await json(await status(t.content, 'bai-1', { status: 'pending_review' }))).body.status, 'pending_review');
  const selfApprove = await json(await status(t.content, 'bai-1', { status: 'approved' }));
  assert.equal(selfApprove.status, 403); assert.equal(selfApprove.body.code, 'forbidden');
  assert.equal(row(e.DB, 'SELECT status FROM drafts WHERE id = ?', 'bai-1').status, 'pending_review');
  // viewer: đọc được danh sách, không tạo/sửa/xóa/đổi trạng thái.
  const seen = await json(await call(e, '/storage/drafts', { headers: t.viewer, shop: t.shopId }));
  assert.equal(seen.status, 200); assert.equal(seen.body.drafts.length, 1);
  assert.equal((await put(t.viewer, 'bai-1', 1, 'Viewer sửa')).status, 403);
  assert.equal((await put(t.viewer, 'bai-moi')).status, 403);
  assert.equal((await status(t.viewer, 'bai-1', { status: 'approved' })).status, 403);
  assert.equal((await call(e, '/storage/drafts/bai-1', { method: 'DELETE', headers: t.viewer, shop: t.shopId })).status, 403);
  assert.equal((await call(e, '/ai', { method: 'POST', headers: t.viewer, shop: t.shopId, body: { task: 'generate', topic: 'x' } })).status, 403, 'viewer không dùng AI');
  // support: không đọc bản nháp dù là thành viên.
  assert.equal((await call(e, '/storage/drafts', { headers: t.support, shop: t.shopId })).status, 403);
  assert.equal((await call(e, '/storage/drafts/bai-1', { headers: t.support, shop: t.shopId })).status, 403);
  assert.equal((await call(e, '/ai', { method: 'POST', headers: t.support, shop: t.shopId, body: { task: 'reply', message: 'x' } })).status, 200, 'support vẫn dùng AI soạn trả lời');
  // manager duyệt; owner cũng duyệt; content có can_publish mới duyệt được.
  assert.equal((await json(await status(t.manager, 'bai-1', { status: 'approved' }))).body.status, 'approved');
  assert.equal(row(e.DB, 'SELECT status FROM drafts WHERE id = ?', 'bai-1').status, 'approved');
  // content sửa bài đã duyệt của mình → quay về draft; content không sửa bài người khác.
  const edited = await json(await put(t.content, 'bai-1', 1, 'Sửa sau duyệt')); // đổi trạng thái không tăng revision
  assert.equal(edited.status, 200); assert.equal(edited.body.status, 'draft');
  assert.equal((await put(t.manager, 'bai-2')).status, 200);
  assert.equal((await put(t.content, 'bai-2', 1, 'content sửa bài manager')).status, 403);
  assert.equal((await status(t.content, 'bai-2', { status: 'pending_review' })).status, 403);
  assert.equal((await status(t.owner, 'bai-2', { assignedTo: 'zalo:content' })).status, 200);
  assert.equal((await put(t.content, 'bai-2', 1, 'content sửa bài được giao')).status, 200);
  assert.equal((await status(t.content, 'bai-2', { assignedTo: 'fb:viewer' })).status, 403, 'content không giao việc');
  assert.equal((await status(t.owner, 'bai-2', { assignedTo: 'nguoi-ngoai' })).status, 404);
  assert.equal((await call(e, '/api/shops/' + t.shopId + '/members/zalo%3Acontent', { method: 'PATCH', headers: t.owner, body: { canPublish: true } })).status, 200);
  assert.equal((await json(await status(t.content, 'bai-2', { status: 'approved' }))).body.status, 'approved');
  // Bản nháp không rò rỉ sang shop khác của cùng người dùng.
  const other = (await json(await call(e, '/session', { headers: t.content }))).body.shop;
  assert.notEqual(other.id, t.shopId);
  assert.deepEqual((await json(await call(e, '/storage/drafts', { headers: t.content }))).body.drafts, []);
});

test('Thành viên: manager không quản lý thành viên, owner cuối không bị xóa/hạ vai trò, tự rời shop, mời không được vai trò owner', async () => {
  const e = env();
  const t = await team(e);
  const members = (await json(await call(e, '/api/shops/' + t.shopId + '/members', { headers: t.viewer }))).body.members;
  assert.deepEqual(members.map(m => m.role), ['owner', 'manager', 'content', 'support', 'viewer']);
  assert.equal(members.find(m => m.role === 'viewer').you, true);
  assert.equal(members[0].name, 'Chủ');
  assert.equal((await call(e, '/api/shops/' + t.shopId + '/invites', { method: 'POST', headers: t.manager, body: { role: 'viewer' } })).status, 403);
  assert.equal((await call(e, '/api/shops/' + t.shopId + '/members/fb%3Aviewer', { method: 'PATCH', headers: t.manager, body: { role: 'content' } })).status, 403);
  assert.equal((await call(e, '/api/shops/' + t.shopId + '/members/fb%3Aviewer', { method: 'DELETE', headers: t.manager })).status, 403);
  assert.equal((await call(e, '/api/shops/' + t.shopId, { method: 'PATCH', headers: t.manager, body: { name: 'Tên mới' } })).status, 200, 'manager được đổi tên shop');
  assert.equal((await call(e, '/api/shops/' + t.shopId, { method: 'PATCH', headers: t.content, body: { name: 'X' } })).status, 403);
  assert.equal((await call(e, '/api/shops/' + t.shopId + '/invites', { method: 'POST', headers: t.owner, body: { role: 'owner' } })).status, 400);
  const demote = await json(await call(e, '/api/shops/' + t.shopId + '/members/email%3Aowner%40shop.vn', { method: 'PATCH', headers: t.owner, body: { role: 'manager' } }));
  assert.equal(demote.status, 409); assert.equal(demote.body.code, 'last_owner');
  const remove = await json(await call(e, '/api/shops/' + t.shopId + '/members/email%3Aowner%40shop.vn', { method: 'DELETE', headers: t.owner }));
  assert.equal(remove.status, 409); assert.equal(remove.body.code, 'last_owner');
  assert.equal(row(e.DB, "SELECT role FROM shop_members WHERE shop_id = ? AND user_id = 'email:owner@shop.vn'", t.shopId).role, 'owner');
  assert.equal((await call(e, '/api/shops/' + t.shopId + '/members/fb%3Aviewer', { method: 'PATCH', headers: t.owner, body: { role: 'support' } })).status, 200);
  assert.equal((await call(e, '/api/shops/' + t.shopId + '/members/fb%3Asupport', { method: 'DELETE', headers: t.support })).status, 200, 'tự rời shop');
  assert.equal((await call(e, '/api/shops/' + t.shopId + '/members', { headers: t.support })).status, 404, 'rời rồi thì không còn là thành viên');
  assert.equal((await call(e, '/api/shops/' + t.shopId + '/members/fb%3Amanager', { method: 'DELETE', headers: t.owner })).status, 200);
  assert.deepEqual(rows(e.DB, 'SELECT action FROM audit_log WHERE shop_id = ? ORDER BY id', t.shopId).map(r => r.action).slice(-4), ['shop.update', 'members.update_role', 'members.leave', 'members.remove']);
});

test('Chuyển quyền sở hữu và xóa shop: chỉ owner, phiên phải mới trong 10 phút; owner cũ thành manager', async () => {
  const e = env();
  const t = await team(e);
  const stale = session(e, 'email:owner@shop.vn', { createdAt: now() - 601 });
  const reauth = await json(await call(e, '/api/shops/' + t.shopId + '/transfer', { method: 'POST', headers: stale, body: { to: 'fb:manager' } }));
  assert.equal(reauth.status, 403); assert.equal(reauth.body.code, 'reauth_required');
  assert.equal((await json(await call(e, '/api/shops/' + t.shopId, { method: 'DELETE', headers: stale }))).body.code, 'reauth_required');
  assert.equal((await call(e, '/api/shops/' + t.shopId + '/transfer', { method: 'POST', headers: t.manager, body: { to: 'fb:viewer' } })).status, 403, 'manager không chuyển được');
  assert.equal((await call(e, '/api/shops/' + t.shopId + '/transfer', { method: 'POST', headers: t.owner, body: { to: 'nguoi-la' } })).status, 404);
  assert.equal((await call(e, '/api/shops/' + t.shopId + '/transfer', { method: 'POST', headers: t.owner, body: { to: 'email:owner@shop.vn' } })).status, 400);
  const fresh = session(e, 'email:owner@shop.vn', { createdAt: now() - 60 });
  const moved = await json(await call(e, '/api/shops/' + t.shopId + '/transfer', { method: 'POST', headers: fresh, body: { to: 'fb:manager' } }));
  assert.equal(moved.status, 200); assert.equal(moved.body.shop.role, 'manager');
  assert.deepEqual(row(e.DB, 'SELECT owner FROM shops WHERE id = ?', t.shopId), { owner: 'fb:manager' });
  assert.deepEqual(row(e.DB, "SELECT role, can_publish FROM shop_members WHERE shop_id = ? AND user_id = 'fb:manager'", t.shopId), { role: 'owner', can_publish: 1 });
  assert.equal(row(e.DB, "SELECT COUNT(*) AS n FROM shop_members WHERE shop_id = ? AND role = 'owner'", t.shopId).n, 1);
  assert.equal((await call(e, '/api/shops/' + t.shopId, { method: 'DELETE', headers: fresh })).status, 403, 'owner cũ (nay là manager) không xóa được');
  const deleted = await json(await call(e, '/api/shops/' + t.shopId, { method: 'DELETE', headers: t.manager }));
  assert.equal(deleted.status, 200); assert.equal(row(e.DB, 'SELECT status FROM shops WHERE id = ?', t.shopId).status, 'deleted');
  assert.equal(row(e.DB, 'SELECT COUNT(*) AS n FROM shops WHERE id = ?', t.shopId).n, 1, 'xóa mềm, không xóa hàng');
  assert.equal((await call(e, '/storage/drafts', { headers: t.manager, shop: t.shopId })).status, 404);
  assert.deepEqual(rows(e.DB, "SELECT action FROM audit_log WHERE shop_id = ? AND action IN ('shop.transfer','shop.delete') ORDER BY id", t.shopId).map(r => r.action), ['shop.transfer', 'shop.delete']);
});

test('Lời mời: hết hạn/thu hồi/đã dùng bị từ chối, dùng một lần, có email thì gửi thư tiếng Việt, /invite/<token> yêu cầu đăng nhập', async () => {
  const e = env();
  const owner = session(e, 'email:owner@shop.vn');
  const shopId = (await json(await call(e, '/api/shops', { method: 'POST', headers: owner, body: { name: 'Shop Mời' } }))).body.shop.id;
  const invite = async body => json(await call(e, '/api/shops/' + shopId + '/invites', { method: 'POST', headers: owner, body }));
  const accept = async (token, who) => json(await call(e, '/api/invites/' + token + '/accept', { method: 'POST', headers: who, body: {} }));
  const tokenOf = r => r.body.link.split('/invite/')[1];
  const guest = session(e, 'fb:guest');
  // Hết hạn.
  const expired = await invite({ role: 'viewer' });
  e.DB.sqlite.prepare('UPDATE shop_invites SET expires_at = ? WHERE id = ?').run(now() - 1, expired.body.invite.id);
  const r1 = await accept(tokenOf(expired), guest); assert.equal(r1.status, 410); assert.equal(r1.body.code, 'invite_expired');
  // Thu hồi.
  const revoked = await invite({ role: 'viewer' });
  assert.equal((await call(e, '/api/shops/' + shopId + '/invites/' + revoked.body.invite.id, { method: 'DELETE', headers: owner })).status, 200);
  const r2 = await accept(tokenOf(revoked), guest); assert.equal(r2.status, 410); assert.equal(r2.body.code, 'invite_revoked');
  assert.equal((await json(await call(e, '/api/invites/' + tokenOf(revoked), { headers: guest }))).body.invite.state, 'revoked');
  // Hợp lệ, dùng một lần; người thứ hai bị từ chối; token lạ 404.
  const ok = await invite({ role: 'content' });
  assert.equal(ok.body.emailed, false); assert.ok(ok.body.invite.expiresAt > now() + 6 * 86400);
  assert.equal(row(e.DB, 'SELECT token_hash FROM shop_invites WHERE id = ?', ok.body.invite.id).token_hash, sha(tokenOf(ok)), 'chỉ lưu băm của token');
  const r3 = await accept(tokenOf(ok), guest); assert.equal(r3.status, 200); assert.equal(r3.body.joined, true); assert.equal(r3.body.shop.role, 'content');
  const r4 = await accept(tokenOf(ok), session(e, 'fb:guest2')); assert.equal(r4.status, 410); assert.equal(r4.body.code, 'invite_accepted');
  assert.equal((await call(e, '/api/invites/' + 'A'.repeat(43) + '/accept', { method: 'POST', headers: guest, body: {} })).status, 404);
  assert.equal((await json(await call(e, '/api/shops/' + shopId + '/invites', { headers: owner }))).body.invites.length, 0, 'không còn lời mời chờ');
  assert.equal((await call(e, '/api/invites/' + tokenOf(ok) + '/accept', { method: 'POST', body: {} })).status, 401, 'chấp nhận cần đăng nhập');
  // Mở link mời khi chưa đăng nhập: trang đăng nhập + cookie nhớ mã mời; đã đăng nhập: giao diện có meta shoppost-invite.
  const anon = await call(e, '/invite/' + tokenOf(ok));
  assert.equal(anon.status, 200); assert.match(await anon.text(), /Đăng nhập Shoppost/);
  assert.match(anon.headers.getSetCookie().join('\n'), /__Host-shopai_invite=[A-Za-z0-9_-]{43}; Max-Age=3600; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  const page = await call(e, '/invite/' + tokenOf(ok), { headers: guest });
  assert.equal(page.status, 200); assert.ok((await page.text()).includes('<meta name="shoppost-invite" content="' + tokenOf(ok) + '">'));
  assert.equal((await call(e, '/invite/ngan')).status, 404);
  // Có email + đã cấu hình gửi thư: gửi thư tiếng Việt qua cùng adapter, không lộ token trong nhật ký.
  const sent = [];
  const withEmail = env({ EMAIL: { send: async message => { sent.push(message); } }, EMAIL_FROM: 'Shoppost <no-reply@shoppost.net>', DB: e.DB });
  const mailed = await json(await call(withEmail, '/api/shops/' + shopId + '/invites', { method: 'POST', headers: owner, body: { role: 'viewer', email: 'Ban@Example.com' } }));
  assert.equal(mailed.status, 201, JSON.stringify(mailed.body)); assert.equal(mailed.body.emailed, true); assert.equal(mailed.body.invite.email, 'ban@example.com');
  assert.equal(sent.length, 1);
  const raw = JSON.stringify(sent[0]);
  assert.ok(raw.includes(tokenOf(mailed)) && /Lời mời tham gia shop/.test(raw) && raw.includes('Shop Mời') && raw.includes('Chỉ xem'), raw.slice(0, 200));
  assert.equal(JSON.stringify(rows(e.DB, 'SELECT * FROM audit_log')).includes(tokenOf(mailed)), false);
});

test('Quản trị nền tảng: chỉ email trong PLATFORM_ADMIN_EMAILS; tổng quan không có nội dung bản nháp; đổi trạng thái shop và đọc nhật ký đều được ghi audit', async () => {
  const e = env();
  const admin = session(e, 'email:ct@pthub.vn');
  const user = session(e, 'email:khach@shop.vn');
  const shopId = (await json(await call(e, '/session', { headers: user }))).body.shop.id;
  assert.equal((await call(e, '/storage/drafts/bi-mat', { method: 'PUT', headers: user, body: { draft: draft('bi-mat', 'NỘI DUNG RIÊNG TƯ'), revision: 0 } })).status, 200);
  for (const path of ['/api/admin/overview', '/api/admin/audit']) assert.equal((await call(e, path, { headers: user })).status, 403);
  assert.equal((await call(e, '/api/admin/shops/' + shopId, { method: 'PATCH', headers: user, body: { status: 'suspended' } })).status, 403);
  assert.equal((await call(e, '/api/admin/overview', { headers: session(e, 'fb:ct-gia-mao', { name: 'ct@pthub.vn' }) })).status, 403, 'tên hiển thị không phải email đã xác minh');
  const overview = await json(await call(e, '/api/admin/overview', { headers: admin }));
  assert.equal(overview.status, 200);
  assert.equal(overview.body.counts.shops, 3, 'shop của khách, của admin và của tài khoản giả mạo'); assert.ok(overview.body.counts.users >= 2); assert.ok(overview.body.counts.sessions >= 2);
  assert.deepEqual(Object.keys(overview.body.shops[0]).sort(), ['createdAt', 'id', 'memberCount', 'name', 'status']);
  assert.equal(JSON.stringify(overview.body).includes('NỘI DUNG RIÊNG TƯ'), false);
  // Admin không phải thành viên thì không đọc được bản nháp/thành viên của shop khách; không có endpoint đọc nội dung.
  assert.equal((await call(e, '/storage/drafts', { headers: admin, shop: shopId })).status, 404);
  assert.equal((await call(e, '/api/shops/' + shopId + '/members', { headers: admin })).status, 404);
  assert.equal((await call(e, '/api/admin/drafts', { headers: admin })).status, 404);
  assert.equal((await call(e, '/api/admin/shops/' + shopId, { method: 'PATCH', headers: admin, body: { status: 'xoa' } })).status, 400);
  assert.equal((await json(await call(e, '/api/admin/shops/' + shopId, { method: 'PATCH', headers: admin, body: { status: 'suspended' } }))).body.status, 'suspended');
  assert.equal((await json(await call(e, '/storage/drafts', { headers: user, shop: shopId }))).body.code, 'shop_suspended');
  assert.equal((await json(await call(e, '/api/admin/shops/' + shopId, { method: 'PATCH', headers: admin, body: { status: 'active' } }))).body.status, 'active');
  assert.equal((await call(e, '/storage/drafts', { headers: user, shop: shopId })).status, 200);
  const audit = await json(await call(e, '/api/admin/audit?limit=10', { headers: admin }));
  assert.equal(audit.status, 200);
  const actions = audit.body.entries.map(x => x.action);
  assert.ok(actions.includes('admin.overview') && actions.includes('admin.shop_status'), actions.join(','));
  assert.equal(audit.body.entries.find(x => x.action === 'admin.shop_status').actor, 'email:ct@pthub.vn');
  assert.equal(JSON.stringify(audit.body).includes('NỘI DUNG RIÊNG TƯ'), false);
  assert.equal((await call(e, '/api/admin/audit?limit=0', { headers: admin })).status, 400);
});

test('/api/shops: tạo shop, giới hạn tên, chọn shop qua header; /session trả shop và quyền', async () => {
  const e = env();
  const me = session(e, 'phone:+84900000001', { provider: 'phone' });
  const first = await json(await call(e, '/api/shops', { headers: me }));
  assert.equal(first.status, 200); assert.equal(first.body.shops.length, 1); assert.equal(first.body.shops[0].name, 'Shop của tôi'); assert.equal(first.body.shops[0].memberCount, 1);
  assert.deepEqual(first.body.roles, ROLE_LABELS); assert.equal(first.body.admin, false);
  assert.equal((await call(e, '/api/shops', { method: 'POST', headers: me, body: { name: '  ' } })).status, 400);
  assert.equal((await call(e, '/api/shops', { method: 'POST', headers: me, body: 'x' })).status, 400);
  assert.equal((await call(e, '/api/shops', { method: 'POST', headers: { ...me, Origin: BASE, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  const made = await json(await call(e, '/api/shops', { method: 'POST', headers: me, body: { name: ' Shop <Thứ hai> ' } }));
  assert.equal(made.status, 201); assert.equal(made.body.shop.name, 'Shop Thứ hai'); assert.equal(made.body.shop.roleLabel, 'Chủ shop');
  const s = await json(await call(e, '/session', { headers: me, shop: made.body.shop.id }));
  assert.equal(s.body.shop.id, made.body.shop.id); assert.equal(s.body.shop.role, 'owner'); assert.equal(s.body.shop.canPublish, true);
  assert.equal((await json(await call(e, '/session', { headers: me }))).body.shop.id, first.body.shops[0].id, 'không có header thì dùng shop mặc định');
  assert.equal((await call(e, '/storage/drafts/a', { method: 'PUT', headers: me, shop: made.body.shop.id, body: { draft: draft('a'), revision: 0 } })).status, 200);
  assert.equal((await json(await call(e, '/storage/drafts', { headers: me }))).body.drafts.length, 0, 'bản nháp nằm đúng shop được chọn');
  assert.equal((await json(await call(e, '/storage/drafts', { headers: me, shop: made.body.shop.id }))).body.drafts.length, 1);
  assert.equal((await call(e, '/api/khong-co', { headers: me })).status, 404);
  assert.equal((await call(e, '/api/shops', { method: 'DELETE', headers: me })).status, 405);
});
