import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqliteDB } from './sqlite-fixture.mjs';
import { handleLibraryStorage } from '../src/library-storage.js';
import { resolveShop } from '../src/shops.js';

test('Library persists original files across clients, scopes access and rejects stale changes', async () => {
  const env = { DB: sqliteDB() };
  const who = { owner: 'library-owner', email: 'owner@example.com' };
  const outsider = { owner: 'library-other', email: 'other@example.com' };
  const base = 'https://app.example/api/library/storage';
  const owned = await resolveShop(env, who, new Request(base));
  const shop = owned.shop.id;
  const json = (body, status = 200) => Response.json(body, { status });
  const request = (path = '', init = {}, user = who) => handleLibraryStorage(
    new Request(base + path, { ...init, headers: { 'X-ShopPost-Shop': shop, ...init.headers } }), env, user, json,
  );
  const data = { id: 'photo', name: 'Ảnh thử', kind: 'image', size: 4, tags: [], source: 'upload', created: 100 };
  const form = new FormData();
  const operationId = crypto.randomUUID();
  form.set('payload', JSON.stringify({ record: data, revision: null, operationId }));
  form.set('file', new Blob(['file'], { type: 'image/png' }), 'photo.png');
  const created = await request('/assets/photo', { method: 'PUT', body: form });
  assert.equal(created.status, 200);
  const { revision } = await created.json();
  assert.equal(revision, operationId);
  const duplicate = await request('/assets/photo', { method: 'PUT', body: form });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).revision, revision);
  const listed = await (await request()).json();
  assert.equal(listed.records[0].record.name, data.name);
  const file = await request('/assets/photo/file');
  assert.equal(file.headers.get('Content-Type'), 'image/png');
  assert.equal(await file.text(), 'file');
  assert.equal((await request('', {}, outsider)).status, 404);
  assert.equal((await request('/assets/photo/file', {}, outsider)).status, 404);
  const update = rev => request('/assets/photo', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: rev, record: { ...data, name: 'Đã sửa' } }),
  });
  assert.equal((await update(null)).status, 409);
  assert.equal((await update(revision)).status, 200);
  assert.equal((await request('/assets/photo', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision }),
  })).status, 409);
  assert.equal(await (await request('/assets/photo/file')).text(), 'file');
  env.DB.sqlite.close();
});
