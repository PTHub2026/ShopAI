// Chỉ lưu bản nháp do người dùng gửi rõ ràng; không nhập seed hoặc tự đăng bài.
export async function drafts(request, env, owner, json) {
    if (!env.DB) return json({ error: 'Chưa gắn cơ sở dữ liệu bản nháp.' }, 503);
    try {
    if (!env.AI_RATE_LIMITER) return json({ error: 'Chưa cấu hình giới hạn yêu cầu.' }, 503);
    const limit = await env.AI_RATE_LIMITER.limit({ key: 'drafts:' + owner });
    if (!limit || typeof limit.success !== 'boolean') throw new Error('RATE_LIMIT_UNAVAILABLE');
    if (!limit.success) return json({ error: 'Quá nhiều yêu cầu lưu trữ. Vui lòng thử lại sau.' }, 429, { 'Retry-After': '60' });
  } catch { return json({ error: 'Giới hạn yêu cầu lưu trữ chưa khả dụng.' }, 503); }
  const url = new URL(request.url);
    const match = /^\/storage\/drafts(?:\/([a-zA-Z0-9_-]{1,64}))?$/.exec(url.pathname);
    if (!match) return json({ error: 'Đường dẫn bản nháp không hợp lệ.' }, 404);
    const id = match[1];
    try {
          if (request.method === 'GET' && !id) {
                  const rows = await env.DB.prepare('SELECT payload, revision, updated_at FROM drafts WHERE owner = ? ORDER BY updated_at DESC LIMIT 100').bind(owner).all();
                  return json({ drafts: rows.results.map(r => ({ draft: JSON.parse(r.payload), revision: r.revision, updatedAt: r.updated_at })) });
          }
          if (request.method !== 'PUT' || !id) return json({ error: 'Chỉ hỗ trợ GET danh sách hoặc PUT theo mã bản nháp.' }, 405);
          if (request.headers.get('Origin') !== url.origin) return json({ error: 'Chỉ cho phép ghi từ cùng origin.' }, 403);
          if ((request.headers.get('Content-Type') || '').split(';')[0].trim() !== 'application/json') return json({ error: 'Cần gửi application/json.' }, 415);
          if (!request.body) return json({ error: 'Thiếu nội dung.' }, 400);
          const reader = request.body.getReader(); const chunks = []; let size = 0;
          while (true) {
                  const { done, value } = await reader.read(); if (done) break;
                  size += value.byteLength;
                  if (size > 32768) { await reader.cancel(); return json({ error: 'Bản nháp vượt giới hạn 32 KB.' }, 413); }
                  chunks.push(value);
          }
          const bytes = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          let body;
          try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
          catch { return json({ error: 'JSON không hợp lệ.' }, 400); }
          const d = body?.draft;
          // Hợp đồng tối thiểu bám S.posts: id, type, content, channels, status.
      if (!d || d.id !== id || d.status !== 'draft' || !['post', 'video'].includes(d.type) || typeof d.content !== 'string' || d.content.length > 20000 || !Array.isArray(d.channels) || d.channels.length > 32 || d.channels.some(c => typeof c !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(c)) || !Number.isSafeInteger(body.revision) || body.revision < 0) return json({ error: 'Bản nháp hoặc số phiên bản không hợp lệ.' }, 400);
          // Chưa hỗ trợ tệp nhị phân, OAuth, tùy biến kênh: không âm thầm làm mất dữ liệu.
      if ((d.media && (!Array.isArray(d.media) || d.media.length)) || (d.assets && (!Array.isArray(d.assets) || d.assets.length)) || (d.custom && Object.keys(d.custom).length)) return json({ error: 'Hiện chỉ lưu bản nháp văn bản chưa có tệp hoặc tùy biến kênh.' }, 422);
          const payload = JSON.stringify({ id, type: d.type, content: d.content, channels: d.channels, status: 'draft', media: [], assets: [], custom: {} });
          const now = Date.now();
          const statement = body.revision === 0
            ? env.DB.prepare('INSERT INTO drafts (owner, id, payload, revision, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(owner, id) DO NOTHING').bind(owner, id, payload, now)
                  : env.DB.prepare('UPDATE drafts SET payload = ?, revision = revision + 1, updated_at = ? WHERE owner = ? AND id = ? AND revision = ?').bind(payload, now, owner, id, body.revision);
          const result = await statement.run();
          if (result.meta.changes !== 1) return json({ error: 'Bản nháp đã thay đổi; tải lại trước khi lưu.' }, 409);
          return json({ draft: JSON.parse(payload), revision: body.revision + 1, updatedAt: now });
    } catch { return json({ error: 'Không thể truy cập kho bản nháp; không xác nhận đã lưu.' }, 503); }
}
