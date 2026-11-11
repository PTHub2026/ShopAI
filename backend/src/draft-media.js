const MAX_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime']);

function bad(message, status = 422) {
  const error = new Error(message);
  error.response = json => json({ error: message }, status);
  throw error;
}

export async function readDraftUpload(request) {
  const reader = request.body?.getReader();
  if (!reader) bad('Thiếu nội dung.', 400);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES + 65536) {
      await reader.cancel();
      bad('Tổng dung lượng tệp bản nháp tối đa 8 MB.', 413);
    }
    chunks.push(value);
  }
  let form, body;
  try {
    form = await new Response(new Blob(chunks), { headers: { 'Content-Type': request.headers.get('Content-Type') } }).formData();
    const payload = form.get('payload');
    if (typeof payload !== 'string' || new TextEncoder().encode(payload).byteLength > 32768) throw new Error();
    body = JSON.parse(payload);
  } catch { bad('Dữ liệu bản nháp không hợp lệ.', 400); }
  const files = form.getAll('file');
  if (!files.length || files.length > 8) bad('Mỗi bản nháp hỗ trợ tối đa 8 tệp.');
  let total = 0;
  const media = files.map(file => {
    if (!(file instanceof Blob) || !TYPES.has(file.type) || !file.size) bad('Tệp cần là ảnh JPG, PNG, GIF, WebP hoặc video MP4, WebM, MOV.');
    total += file.size;
    return { id: crypto.randomUUID(), name: file.name.slice(0, 180), type: file.type, size: file.size };
  });
  if (total > MAX_BYTES) bad('Tổng dung lượng tệp bản nháp tối đa 8 MB.', 413);
  return { body, files, media };
}

export async function draftMediaWrite(db, statement, { shopId, id, revision, payload, files, media }) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS draft_media_chunks (
    owner TEXT NOT NULL, draft_id TEXT NOT NULL, media_id TEXT NOT NULL,
    part INTEGER NOT NULL, data BLOB NOT NULL,
    PRIMARY KEY (owner, draft_id, media_id, part),
    FOREIGN KEY (owner, draft_id) REFERENCES drafts(owner, id) ON DELETE CASCADE
  )`).run();
  const current = 'shop_id = ? AND id = ? AND revision = ? AND payload = ?';
  const params = [shopId, id, revision, payload];
  const statements = [statement];
  const keep = media.map(file => file.id);
  const exclude = keep.length ? ' AND media_id NOT IN (' + keep.map(() => '?').join(', ') + ')' : '';
  statements.push(db.prepare('DELETE FROM draft_media_chunks WHERE draft_id = ? AND owner IN (SELECT owner FROM drafts WHERE ' + current + ')' + exclude).bind(id, ...params, ...keep));
  for (const [index, file] of files.entries()) {
    for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
      const data = await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer();
      statements.push(db.prepare('INSERT INTO draft_media_chunks (owner, draft_id, media_id, part, data) SELECT owner, id, ?, ?, ? FROM drafts WHERE ' + current).bind(media[index].id, offset / CHUNK_BYTES, data, ...params));
    }
  }
  const [result] = await db.batch(statements);
  return result;
}

export async function draftMediaRead(db, row, mediaId, json) {
  const file = row && JSON.parse(row.payload).media?.find(media => media.id === mediaId);
  if (!file || !TYPES.has(file.type)) return json({ error: 'Không tìm thấy tệp bản nháp.' }, 404);
  const { results } = await db.prepare('SELECT data FROM draft_media_chunks WHERE owner = ? AND draft_id = ? AND media_id = ? ORDER BY part').bind(row.owner, row.id, mediaId).all();
  const parts = results.map(({ data }) => new Uint8Array(data));
  if (parts.reduce((size, part) => size + part.byteLength, 0) !== file.size) return json({ error: 'Tệp bản nháp đã thay đổi hoặc không còn.' }, 404);
  return new Response(new Blob(parts), { headers: {
    'Content-Type': file.type, 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox"
  } });
}
