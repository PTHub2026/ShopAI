import { DRAFT_STATUSES } from './shops.js';
const ID = /^[a-zA-Z0-9_-]{1,64}$/;
const FIELDS = new Set(['id', 'type', 'content', 'channels', 'status', 'media', 'assets', 'custom']);
const rowData = row => ({ draft: JSON.parse(row.payload), revision: row.revision, updatedAt: row.updated_at, status: row.status || 'draft', createdBy: row.created_by || row.owner || null, assignedTo: row.assigned_to || null });
const FORBIDDEN = { error: 'Bạn không có quyền thực hiện thao tác này với bản nháp trong shop hiện tại.', code: 'forbidden' };
const SELECT = 'SELECT owner, id, payload, revision, updated_at, status, created_by, assigned_to FROM drafts';

// Chỉ bản nháp văn bản tường minh; mọi truy vấn đều giới hạn theo shop hiện hành (ctx.shop) và quyền của người dùng (ctx.can).
// owner = danh tính đã xác minh (Access sub hoặc phiên đăng nhập); ctx do worker giải quyết từ header X-ShopPost-Shop / shop mặc định.
export async function drafts(request, env, owner, json, ctx) {
  const url = new URL(request.url);
  const match = /^\/storage\/drafts(?:\/([a-zA-Z0-9_-]{1,64})(\/status)?)?$/.exec(url.pathname);
  if (!match) return json({ error: 'Đường dẫn bản nháp không hợp lệ.' }, 404);
  if (!env.DB) return json({ error: 'Chưa gắn cơ sở dữ liệu bản nháp.' }, 503);
  if (!ctx || !ctx.shop || typeof ctx.can !== 'function') return json({ error: 'Thiếu ngữ cảnh shop.' }, 403);
  const id = match[1], statusRoute = Boolean(match[2]), shopId = ctx.shop.id;
  const mine = row => row && (row.created_by === owner || row.assigned_to === owner || row.owner === owner);
  const mayEdit = row => ctx.can('drafts.edit_any') || (ctx.can('drafts.edit_own') && mine(row));
  if (statusRoute ? request.method !== 'POST' : request.method !== 'GET' && !((request.method === 'PUT' || request.method === 'DELETE') && id)) {
    return json({ error: statusRoute ? 'Chỉ hỗ trợ POST để đổi trạng thái.' : 'Chỉ hỗ trợ đọc bản nháp, PUT hoặc DELETE theo mã bản nháp.' }, 405, { Allow: statusRoute ? 'POST' : id ? 'GET, PUT, DELETE' : 'GET' });
  }
  if (request.method !== 'GET' && request.headers.get('Origin') !== url.origin) {
    return json({ error: 'Chỉ cho phép ghi từ cùng origin.' }, 403);
  }
  if (!ctx.can('drafts.view')) return json(FORBIDDEN, 403);
  // Chỉ áp giới hạn tần suất cho thao tác ghi (PUT/DELETE/POST); đọc (GET) không bị giới hạn.
  if (request.method !== 'GET') {
    try {
      const limit = await env.AI_RATE_LIMITER?.limit({ key: 'drafts-write:' + owner });
      if (!limit || typeof limit.success !== 'boolean') throw new Error('RATE_LIMIT_UNAVAILABLE');
      if (!limit.success) return json({ error: 'Quá nhiều yêu cầu lưu trữ. Vui lòng thử lại sau.' }, 429, { 'Retry-After': '60' });
    } catch { return json({ error: 'Giới hạn yêu cầu lưu trữ chưa khả dụng.' }, 503); }
  }

  try {
    if (request.method === 'GET' && id) {
      const row = await env.DB.prepare(SELECT + ' WHERE shop_id = ? AND id = ?').bind(shopId, id).first();
      return row ? json(rowData(row)) : json({ error: 'Không tìm thấy bản nháp.' }, 404);
    }
    if (statusRoute) {
      const row = await env.DB.prepare(SELECT + ' WHERE shop_id = ? AND id = ?').bind(shopId, id).first();
      if (!row) return json({ error: 'Không tìm thấy bản nháp.' }, 404);
      let body;
      try { body = await readBody(request); } catch (error) { return error.response ? error.response(json) : json({ error: 'JSON không hợp lệ.' }, 400); }
      const next = body.status;
      if (next !== undefined) {
        if (!DRAFT_STATUSES.includes(next)) return json({ error: 'Trạng thái phải là draft, pending_review hoặc approved.' }, 400);
        const allowed = next === 'approved' ? ctx.can('drafts.approve')
          : next === 'pending_review' ? ctx.can('drafts.submit') && mayEdit(row)
          : ctx.can('drafts.approve') || (ctx.can('drafts.submit') && mayEdit(row));
        if (!allowed) return json(FORBIDDEN, 403);
      }
      let assignedTo = row.assigned_to || null;
      if (body.assignedTo !== undefined) {
        if (!ctx.can('drafts.edit_any')) return json(FORBIDDEN, 403);
        if (body.assignedTo === null || body.assignedTo === '') assignedTo = null;
        else {
          if (typeof body.assignedTo !== 'string' || body.assignedTo.length > 256) return json({ error: 'Người được giao không hợp lệ.' }, 400);
          const member = await env.DB.prepare('SELECT 1 AS ok FROM shop_members WHERE shop_id = ? AND user_id = ?').bind(shopId, body.assignedTo).first();
          if (!member) return json({ error: 'Người được giao phải là thành viên của shop.' }, 404);
          assignedTo = body.assignedTo;
        }
      }
      if (next === undefined && body.assignedTo === undefined) return json({ error: 'Thiếu status hoặc assignedTo.' }, 400);
      const now = Date.now();
      const res = await env.DB.prepare('UPDATE drafts SET status = ?, assigned_to = ?, updated_at = ? WHERE shop_id = ? AND id = ? AND revision = ?').bind(next === undefined ? row.status : next, assignedTo, now, shopId, id, row.revision).run();
      if (res.meta.changes !== 1) return json({ error: 'Bản nháp đã thay đổi trên máy chủ. Tải lại danh sách.' }, 409);
      const fresh = await env.DB.prepare(SELECT + ' WHERE shop_id = ? AND id = ?').bind(shopId, id).first();
      return json(rowData(fresh));
    }
    if (request.method === 'GET') {
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return json({ error: 'Giới hạn trang phải từ 1 đến 100.' }, 400);
      let cursor;
      if (url.searchParams.has('cursor')) {
        try {
          cursor = JSON.parse(atob(url.searchParams.get('cursor').replace(/-/g, '+').replace(/_/g, '/')));
          if (!Array.isArray(cursor) || cursor.length !== 2 || !Number.isSafeInteger(cursor[0]) || cursor[0] < 0 || typeof cursor[1] !== 'string' || !ID.test(cursor[1])) throw new Error('CURSOR');
        } catch { return json({ error: 'Vị trí trang không hợp lệ.' }, 400); }
      }
      const query = cursor
        ? env.DB.prepare(SELECT + ' WHERE shop_id = ? AND (updated_at < ? OR (updated_at = ? AND id < ?)) ORDER BY updated_at DESC, id DESC LIMIT ?').bind(shopId, cursor[0], cursor[0], cursor[1], limit + 1)
        : env.DB.prepare(SELECT + ' WHERE shop_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?').bind(shopId, limit + 1);
      const { results } = await query.all();
      const rows = results.slice(0, limit), last = rows.at(-1);
      const nextCursor = results.length > limit ? btoa(JSON.stringify([last.updated_at, last.id])).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : null;
      return json({ drafts: rows.map(rowData), nextCursor });
    }
    if (request.method === 'DELETE') {
      const row = await env.DB.prepare(SELECT + ' WHERE shop_id = ? AND id = ?').bind(shopId, id).first();
      if (!row) return json({ deleted: false });
      if (!(ctx.can('drafts.delete') || (ctx.can('drafts.edit_own') && mine(row)))) return json(FORBIDDEN, 403);
      const res = await env.DB.prepare('DELETE FROM drafts WHERE shop_id = ? AND id = ?').bind(shopId, id).run();
      return json({ deleted: res.meta.changes > 0 });
    }
    let body;
    try { body = await readBody(request); } catch (error) { return error.response ? error.response(json) : json({ error: 'JSON không hợp lệ.' }, 400); }
    const d = body?.draft;
    if (!d || Array.isArray(d) || d.id !== id || d.status !== 'draft' || !['post', 'video'].includes(d.type) || typeof d.content !== 'string' || !d.content.trim() || d.content.length > 20000 || !Array.isArray(d.channels) || d.channels.length > 32 || new Set(d.channels).size !== d.channels.length || d.channels.some(c => typeof c !== 'string' || !ID.test(c)) || !Number.isSafeInteger(body.revision) || body.revision < 0 || body.revision >= Number.MAX_SAFE_INTEGER) {
      return json({ error: 'Bản nháp hoặc số phiên bản không hợp lệ.' }, 400);
    }
    if (Object.keys(d).some(k => !FIELDS.has(k)) || ['media', 'assets'].some(k => k in d && (!Array.isArray(d[k]) || d[k].length)) || ('custom' in d && (!d.custom || Array.isArray(d.custom) || typeof d.custom !== 'object' || Object.keys(d.custom).length))) {
      return json({ error: 'Hiện chỉ lưu bản nháp văn bản chưa có tệp, lịch đăng hoặc tùy biến kênh.' }, 422);
    }
    const payload = JSON.stringify({ id, type: d.type, content: d.content, channels: d.channels, status: 'draft', media: [], assets: [], custom: {} });
    const now = Date.now();
    const existing = await env.DB.prepare(SELECT + ' WHERE shop_id = ? AND id = ?').bind(shopId, id).first();
    if (body.revision === 0) {
      if (!ctx.can('drafts.create')) return json(FORBIDDEN, 403);
      if (existing) return json({ error: 'Bản nháp đã thay đổi trên máy chủ. Mở lại hoặc lưu thành bản mới.' }, 409);
    } else {
      if (!existing) return json({ error: 'Bản nháp không còn trên máy chủ. Mở lại hoặc lưu thành bản mới.' }, 409);
      if (!mayEdit(existing)) return json(FORBIDDEN, 403);
    }
    // Sửa nội dung bản đã gửi duyệt/đã duyệt bởi người không có quyền duyệt thì bản nháp quay về trạng thái draft.
    const status = !existing ? 'draft' : (existing.status && existing.status !== 'draft' && !ctx.can('drafts.approve')) ? 'draft' : existing.status || 'draft';
    const statement = body.revision === 0
      ? env.DB.prepare("INSERT INTO drafts (owner, id, payload, revision, updated_at, shop_id, status, assigned_to, created_by) VALUES (?, ?, ?, 1, ?, ?, 'draft', NULL, ?) ON CONFLICT(owner, id) DO NOTHING").bind(owner, id, payload, now, shopId, owner)
      : env.DB.prepare('UPDATE drafts SET payload = ?, revision = revision + 1, updated_at = ?, status = ? WHERE shop_id = ? AND id = ? AND revision = ?').bind(payload, now, status, shopId, id, body.revision);
    const result = await statement.run();
    if (result.meta.changes !== 1) {
      // Khi tạo mới (revision=0): xung đột PRIMARY KEY (owner, id) có thể xảy ra nếu owner
      // đã tạo bản nháp cùng ID trong một shop khác (shop_id khác). Phân biệt trường hợp này
      // để trả thông điệp lỗi rõ ràng thay vì thông điệp "đã thay đổi trên máy chủ" gây nhầm lẫn.
      if (body.revision === 0) {
        const crossShop = await env.DB.prepare('SELECT shop_id FROM drafts WHERE owner = ? AND id = ?').bind(owner, id).first();
        if (crossShop && crossShop.shop_id !== shopId) return json({ error: 'Mã bản nháp này đã được dùng trong shop khác. Hãy lưu với mã khác.' }, 409);
      }
      return json({ error: 'Bản nháp đã thay đổi trên máy chủ. Mở lại hoặc lưu thành bản mới.' }, 409);
    }
    return json({ draft: JSON.parse(payload), revision: body.revision + 1, updatedAt: now, status, createdBy: existing ? existing.created_by || existing.owner : owner, assignedTo: existing ? existing.assigned_to || null : null });
  } catch { return json({ error: 'Không thể truy cập kho bản nháp; không xác nhận đã lưu.' }, 503); }
}

// Đọc JSON tối đa 32 KB; lỗi mang theo phản hồi phù hợp (415/400/413).
async function readBody(request) {
  const fail = (message, status) => { const error = new Error(message); error.response = json => json({ error: message }, status); return error; };
  if ((request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') throw fail('Cần gửi application/json.', 415);
  if (!request.body) throw fail('Thiếu nội dung.', 400);
  const reader = request.body.getReader(), chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 32768) { await reader.cancel(); throw fail('Bản nháp vượt giới hạn 32 KB.', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw fail('JSON không hợp lệ.', 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('JSON không hợp lệ.', 400);
  return body;
}
