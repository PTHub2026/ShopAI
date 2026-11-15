import { readJson } from './auth.js';
import { resolveShop } from './shops.js';

const ROOT = '/api/library/storage';
const ID = /^[a-zA-Z0-9_-]{1,64}$/;
const CHUNK = 1792 * 1024;
const MAX_FILE = 50 * 1024 * 1024;
const MAX_METADATA = 256 * 1024;
const INLINE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'video/mp4', 'video/webm', 'video/quicktime']);
const schema = new WeakMap();

function storageReady(db) {
  if (!schema.has(db)) {
    const ready = db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS shop_library (
        shop_id TEXT NOT NULL REFERENCES shops(id), bucket TEXT NOT NULL, id TEXT NOT NULL,
        revision TEXT NOT NULL, payload TEXT, file_type TEXT, file_size INTEGER,
        PRIMARY KEY (shop_id, bucket, id)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS shop_library_chunks (
        shop_id TEXT NOT NULL, bucket TEXT NOT NULL, id TEXT NOT NULL, part INTEGER NOT NULL, bytes BLOB NOT NULL,
        PRIMARY KEY (shop_id, bucket, id, part),
        FOREIGN KEY (shop_id, bucket, id) REFERENCES shop_library(shop_id, bucket, id) ON DELETE CASCADE
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS shop_library_upload_parts (
        shop_id TEXT NOT NULL, upload TEXT NOT NULL, part INTEGER NOT NULL, created INTEGER NOT NULL, bytes BLOB NOT NULL,
        PRIMARY KEY (shop_id, upload, part)
      )`),
      db.prepare('CREATE INDEX IF NOT EXISTS shop_library_upload_age ON shop_library_upload_parts (created)'),
    ]).catch(error => { schema.delete(db); throw error; });
    schema.set(db, ready);
  }
  return schema.get(db);
}

function webUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function recordFor(bucket, id, value) {
  if (value?.id !== id || typeof value.name !== 'string' || !value.name.trim()) return null;
  const record = { id, name: value.name.trim().slice(0, 240) };
  if (bucket === 'folders') return record;
  if (!['image', 'video', 'text', 'link', 'doc'].includes(value.kind) ||
      !['upload', 'drive', 'dropbox', 'onedrive', 'email', 'url', 'post', 'video'].includes(value.source) ||
      !Number.isSafeInteger(value.created) || value.created < 0) return null;
  const thumb = typeof value.thumb === 'string' && value.thumb.startsWith('data:image/jpeg;base64,') &&
    /^[A-Za-z0-9+/=]+$/.test(value.thumb.slice(23)) && value.thumb.length < 180000 ? value.thumb : webUrl(value.thumb);
  return {
    ...record, kind: value.kind, source: value.source, created: value.created,
    folder: typeof value.folder === 'string' && ID.test(value.folder) ? value.folder : null,
    tags: Array.isArray(value.tags) ? value.tags.filter(tag => typeof tag === 'string').slice(0, 50).map(tag => tag.slice(0, 80)) : [],
    size: Number.isSafeInteger(value.size) && value.size >= 0 ? value.size : 0,
    ...(typeof value.text === 'string' ? { text: value.text.slice(0, 20000) } : {}),
    ...(typeof value.rid === 'string' ? { rid: value.rid.slice(0, 2048) } : {}),
    ...(Number.isFinite(value.dur) ? { dur: value.dur } : {}),
    url: webUrl(value.url), thumb,
  };
}

async function upload(request) {
  if (!request.headers.get('Content-Type')?.startsWith('multipart/form-data;')) {
    return { body: await readJson(request, MAX_METADATA), file: null };
  }
  let bytes = 0;
  const bounded = request.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > MAX_FILE + MAX_METADATA + 8192) throw Error('SIZE');
      controller.enqueue(chunk);
    },
  }));
  const form = await new Response(bounded, { headers: { 'Content-Type': request.headers.get('Content-Type') } }).formData();
  const payload = form.get('payload');
  const file = form.get('file');
  if (typeof payload !== 'string' || new TextEncoder().encode(payload).length > MAX_METADATA) throw Error('SIZE');
  if (!(file instanceof Blob) || !file.size || file.size > MAX_FILE) throw Error('SIZE');
  return { body: JSON.parse(payload), file };
}

function libraryFile(db, key, row, json) {
  if (!row?.payload || !row.file_size) return json({ error: 'Không tìm thấy tệp trong Kho.' }, 404);
  let part = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      const chunk = await db.prepare('SELECT bytes FROM shop_library_chunks WHERE shop_id = ? AND bucket = ? AND id = ? AND part = ?').bind(...key, part).first();
      const expected = Math.min(CHUNK, row.file_size - part * CHUNK);
      const bytes = chunk ? new Uint8Array(chunk.bytes) : null;
      if (bytes?.byteLength !== expected) throw Error('Tệp trong Kho đã thay đổi.');
      controller.enqueue(bytes);
      if (++part * CHUNK >= row.file_size) controller.close();
    },
  });
  const name = JSON.parse(row.payload).name;
  return new Response(stream, { headers: {
    'Content-Type': row.file_type,
    'Content-Length': String(row.file_size),
    'Content-Disposition': `${INLINE_TYPES.has(row.file_type) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
  } });
}

export async function handleLibraryStorage(request, env, who, json) {
  const url = new URL(request.url);
  const shopId = request.headers.get('X-ShopPost-Shop');
  if (!shopId) return json({ error: 'Chọn shop trước khi mở Kho.' }, 400);
  if (!env.DB) return json({ error: 'Kho máy chủ tạm thời không khả dụng.' }, 503);
  const db = env.DB;
  try {
    const context = await resolveShop(env, who, request);
    if (context.error) return json({ error: context.error, code: context.code }, context.status);
    const reading = request.method === 'GET';
    if (!context.can(reading ? 'drafts.view' : 'drafts.create')) {
      return json({ error: 'Vai trò hiện tại không có quyền thao tác với Kho.', code: 'forbidden' }, 403);
    }
    const path = url.pathname.slice(ROOT.length);
    if (!path && reading) {
      const offset = url.searchParams.get('after') || '';
      if (offset && !/^(assets|folders):[a-zA-Z0-9_-]{1,64}$/.test(offset)) return json({ error: 'Trang không hợp lệ.' }, 400);
      await storageReady(db);
      const { results } = await db.prepare(`SELECT bucket, id, revision, payload, file_type, file_size FROM shop_library
        WHERE shop_id = ? AND (bucket, id) > (?, ?) ORDER BY bucket, id LIMIT 21`).bind(shopId, ...(offset ? offset.split(':') : ['', ''])).all();
      const records = results.slice(0, 20).map(row => ({
        bucket: row.bucket, id: row.id, revision: row.revision, record: row.payload ? JSON.parse(row.payload) : null,
        file: row.file_size ? { type: row.file_type, size: row.file_size } : null,
      }));
      return json({ records, next: results.length > 20 ? records[19].bucket + ':' + records[19].id : null });
    }
    const match = /^\/(assets|folders)\/([a-zA-Z0-9_-]{1,64})(\/file)?$/.exec(path);
    if (!match) return json({ error: 'Không tìm thấy đường dẫn Kho.' }, 404);
    const [, bucket, id, filePath] = match;
    const key = [shopId, bucket, id];
    await storageReady(db);
    const condition = 'shop_id = ? AND bucket = ? AND id = ?';
    const row = await db.prepare('SELECT revision, payload, file_type, file_size FROM shop_library WHERE ' + condition).bind(...key).first();
    if (reading && filePath && bucket === 'assets') return libraryFile(db, key, row, json);
    if (filePath || !['PUT', 'DELETE'].includes(request.method)) return json({ error: 'Phương thức không được hỗ trợ.' }, 405);
    const deleting = request.method === 'DELETE';
    let body, file;
    try { ({ body, file } = deleting ? { body: await readJson(request, 4096), file: null } : await upload(request)); }
    catch (error) { return json({ error: error.message === 'SIZE' ? 'Tệp tối đa 50 MB hoặc thông tin tài nguyên vượt giới hạn.' : 'Dữ liệu tài nguyên không hợp lệ.' }, error.message === 'SIZE' ? 413 : 400); }
    if (body?.revision !== null && (typeof body?.revision !== 'string' || !ID.test(body.revision))) return json({ error: 'Thiếu phiên bản tài nguyên.' }, 400);
    const record = deleting ? null : recordFor(bucket, id, body.record);
    if ((!deleting && !record) || (file && bucket !== 'assets')) return json({ error: 'Tài nguyên không hợp lệ.' }, 422);
    if (body.operationId !== undefined && (typeof body.operationId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.operationId))) return json({ error: 'Mã đồng bộ không hợp lệ.' }, 400);
    const revision = body.operationId || crypto.randomUUID();
    if (row?.revision === revision) {
      return json({ bucket, id, revision, record: row.payload ? JSON.parse(row.payload) : null, file: row.file_size ? { type: row.file_type, size: row.file_size } : null });
    }
    const fileType = deleting ? null : file ? (INLINE_TYPES.has(file.type) ? file.type : 'application/octet-stream') : row?.file_type ?? null;
    const fileSize = deleting ? null : file?.size ?? row?.file_size ?? null;
    const payload = record ? JSON.stringify(record) : null;
    if ((row?.revision ?? null) !== body.revision) return json({ error: 'Tài nguyên đã đổi trên thiết bị khác.', code: 'library_conflict' }, 409);
    if (file && row?.file_size) return json({ error: 'Tệp gốc đã được lưu. Hãy thêm tài nguyên mới để thay tệp.' }, 422);
    // Bind the file writes to the winning revision and commit them with the metadata.
    const write = row
      ? db.prepare('UPDATE shop_library SET revision = ?, payload = ?, file_type = ?, file_size = ? WHERE ' + condition + ' AND revision = ?').bind(revision, payload, fileType, fileSize, ...key, body.revision)
      : db.prepare('INSERT INTO shop_library (shop_id, bucket, id, revision, payload, file_type, file_size) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(...key, revision, payload, fileType, fileSize);
    const statements = [write];
    const cleanup = db.prepare('DELETE FROM shop_library_upload_parts WHERE shop_id = ? AND upload = ?').bind(shopId, revision);
    if (deleting) statements.push(db.prepare(`DELETE FROM shop_library_chunks WHERE ${condition} AND EXISTS (SELECT 1 FROM shop_library WHERE ${condition} AND revision = ?)`).bind(...key, ...key, revision));
    if (file) {
      const now = Date.now();
      try {
        await db.prepare('DELETE FROM shop_library_upload_parts WHERE created < ?').bind(now - 3600000).run();
        for (let offset = 0; offset < file.size; offset += CHUNK) {
          const bytes = await file.slice(offset, offset + CHUNK).arrayBuffer();
          await db.prepare('INSERT INTO shop_library_upload_parts (shop_id, upload, part, created, bytes) VALUES (?, ?, ?, ?, ?)').bind(shopId, revision, offset / CHUNK, now, bytes).run();
        }
      } catch (error) {
        await cleanup.run();
        throw error;
      }
      statements.push(db.prepare(`INSERT INTO shop_library_chunks (shop_id, bucket, id, part, bytes)
        SELECT ?, ?, ?, part, bytes FROM shop_library_upload_parts
        WHERE shop_id = ? AND upload = ?
        AND EXISTS (SELECT 1 FROM shop_library WHERE ${condition} AND revision = ?)`).bind(...key, shopId, revision, ...key, revision));
      statements.push(cleanup);
    }
    let result;
    try { [result] = await db.batch(statements); }
    catch (error) {
      if (file) await cleanup.run();
      throw error;
    }
    if (!result.meta.changes) return json({ error: 'Tài nguyên đã đổi trên thiết bị khác.', code: 'library_conflict' }, 409);
    return json({ bucket, id, revision, record, file: fileSize ? { type: fileType, size: fileSize } : null });
  } catch {
    return json({ error: 'Kho máy chủ tạm thời không khả dụng. Hãy thử lại.' }, 503);
  }
}
