const ID = /^[a-zA-Z0-9_-]{1,64}$/;
const FIELDS = new Set(['id', 'type', 'content', 'channels', 'status', 'media', 'assets', 'custom']);
const rowData = row => ({ draft: JSON.parse(row.payload), revision: row.revision, updatedAt: row.updated_at });

// Only explicit text drafts; every query is scoped to the verified Access subject.
export async function drafts(request, env, owner, json) {
  const url = new URL(request.url);
  const match = /^\/storage\/drafts(?:\/([a-zA-Z0-9_-]{1,64}))?$/.exec(url.pathname);
  if (!match) return json({ error: 'Đường dẫn bản nháp không hợp lệ.' }, 404);
  if (!env.DB) return json({ error: 'Chưa gắn cơ sở dữ liệu bản nháp.' }, 503);
  const id = match[1];
  if (request.method !== 'GET' && !((request.method === 'PUT' || request.method === 'DELETE') && id)) {
    return json({ error: 'Chỉ hỗ trợ đọc bản nháp, PUT hoặc DELETE theo mã bản nháp.' }, 405, { Allow: id ? 'GET, PUT, DELETE' : 'GET' });
  }
  if ((request.method === 'PUT' || request.method === 'DELETE') && request.headers.get('Origin') !== url.origin) {
    return json({ error: 'Chỉ cho phép ghi từ cùng origin.' }, 403);
  }
  // Chỉ áp giới hạn tần suất cho thao tác ghi (PUT/DELETE); đọc (GET) không bị giới hạn.
  if (request.method !== 'GET') {
    try {
      const limit = await env.AI_RATE_LIMITER?.limit({ key: 'drafts-write:' + owner });
      if (!limit || typeof limit.success !== 'boolean') throw new Error('RATE_LIMIT_UNAVAILABLE');
      if (!limit.success) return json({ error: 'Quá nhiều yêu cầu lưu trữ. Vui lòng thử lại sau.' }, 429, { 'Retry-After': '60' });
    } catch { return json({ error: 'Giới hạn yêu cầu lưu trữ chưa khả dụng.' }, 503); }
  }

  try {
    if (request.method === 'GET' && id) {
      const row = await env.DB.prepare('SELECT payload, revision, updated_at FROM drafts WHERE owner = ? AND id = ?').bind(owner, id).first();
      return row ? json(rowData(row)) : json({ error: 'Không tìm thấy bản nháp.' }, 404);
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
        ? env.DB.prepare('SELECT id, payload, revision, updated_at FROM drafts WHERE owner = ? AND (updated_at < ? OR (updated_at = ? AND id < ?)) ORDER BY updated_at DESC, id DESC LIMIT ?').bind(owner, cursor[0], cursor[0], cursor[1], limit + 1)
        : env.DB.prepare('SELECT id, payload, revision, updated_at FROM drafts WHERE owner = ? ORDER BY updated_at DESC, id DESC LIMIT ?').bind(owner, limit + 1);
      const { results } = await query.all();
      const rows = results.slice(0, limit), last = rows.at(-1);
      const nextCursor = results.length > limit ? btoa(JSON.stringify([last.updated_at, last.id])).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : null;
      return json({ drafts: rows.map(rowData), nextCursor });
    }
    if (request.method === 'DELETE') {
      const res = await env.DB.prepare('DELETE FROM drafts WHERE owner = ? AND id = ?').bind(owner, id).run();
      return json({ deleted: res.meta.changes > 0 });
    }
    if ((request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: 'Cần gửi application/json.' }, 415);
    if (!request.body) return json({ error: 'Thiếu nội dung.' }, 400);
    const reader = request.body.getReader(), chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32768) { await reader.cancel(); return json({ error: 'Bản nháp vượt giới hạn 32 KB.' }, 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { return json({ error: 'JSON không hợp lệ.' }, 400); }
    const d = body?.draft;
    if (!d || Array.isArray(d) || d.id !== id || d.status !== 'draft' || !['post', 'video'].includes(d.type) || typeof d.content !== 'string' || !d.content.trim() || d.content.length > 20000 || !Array.isArray(d.channels) || d.channels.length > 32 || new Set(d.channels).size !== d.channels.length || d.channels.some(c => typeof c !== 'string' || !ID.test(c)) || !Number.isSafeInteger(body.revision) || body.revision < 0 || body.revision >= Number.MAX_SAFE_INTEGER) {
      return json({ error: 'Bản nháp hoặc số phiên bản không hợp lệ.' }, 400);
    }
    if (Object.keys(d).some(k => !FIELDS.has(k)) || ['media', 'assets'].some(k => k in d && (!Array.isArray(d[k]) || d[k].length)) || ('custom' in d && (!d.custom || Array.isArray(d.custom) || typeof d.custom !== 'object' || Object.keys(d.custom).length))) {
      return json({ error: 'Hiện chỉ lưu bản nháp văn bản chưa có tệp, lịch đăng hoặc tùy biến kênh.' }, 422);
    }
    const payload = JSON.stringify({ id, type: d.type, content: d.content, channels: d.channels, status: 'draft', media: [], assets: [], custom: {} });
    const now = Date.now();
    const statement = body.revision === 0
      ? env.DB.prepare('INSERT INTO drafts (owner, id, payload, revision, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(owner, id) DO NOTHING').bind(owner, id, payload, now)
      : env.DB.prepare('UPDATE drafts SET payload = ?, revision = revision + 1, updated_at = ? WHERE owner = ? AND id = ? AND revision = ?').bind(payload, now, owner, id, body.revision);
    const result = await statement.run();
    if (result.meta.changes !== 1) return json({ error: 'Bản nháp đã thay đổi trên máy chủ. Mở lại hoặc lưu thành bản mới.' }, 409);
    return json({ draft: JSON.parse(payload), revision: body.revision + 1, updatedAt: now });
  } catch { return json({ error: 'Không thể truy cập kho bản nháp; không xác nhận đã lưu.' }, 503); }
}
