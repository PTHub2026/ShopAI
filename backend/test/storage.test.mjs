import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { drafts } from '../src/drafts.js';
import { can } from '../src/permissions.js';

// Real SQL/schema; adapt only the D1 asynchronous result envelope.
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_drafts.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0003_shops_roles.sql', import.meta.url), 'utf8'));
  return { sqlite, prepare(sql) {
    const statement = sqlite.prepare(sql);
    return { bind(...params) { return {
      async all() { return { results: statement.all(...params) }; },
      async first() { return statement.get(...params) || null; },
      async run() { return { meta: { changes: Number(statement.run(...params).changes) } }; }
    }; } };
  } };
}
const draft = (id='draft-a', content='Nội dung người dùng') => ({ id, type:'post', content, channels:[], status:'draft', media:[], assets:[], custom:{} });
const json = (data, status=200, headers={}) => Response.json(data, { status, headers });
// Mỗi owner là chủ shop riêng (s_<owner>) — cách ly dữ liệu giờ theo shop hiện hành do worker giải quyết.
const ctxFor = (owner, role='owner') => ({ shop:{ id:'s_'+owner.padEnd(8,'x') }, membership:{ role, can_publish: role==='owner' }, can: action => can({ role, can_publish: role==='owner' }, action) });
function call(DB, {owner='alice', id='draft-a', method='PUT', body={draft:draft(id),revision:0}, query='', headers={}, raw, limiter, role}={}) {
  const url='https://app.example/storage/drafts'+(id ? '/'+id : '')+query;
  const sendBody = method!=='GET' && method!=='DELETE';
  return drafts(new Request(url, { method, headers:{Origin:'https://app.example','Content-Type':'application/json',...headers}, ...(sendBody?{body:raw ?? JSON.stringify(body)}:{}) }), { DB, AI_RATE_LIMITER: limiter || {limit:async()=>({success:true})} }, owner, json, ctxFor(owner, role));
}
test('Draft revisions prevent overwrites and isolate owners', async()=>{
  const db=database();
  try {
    assert.equal((await call(db)).status,200);
    assert.equal((await call(db)).status,409);
    assert.equal((await call(db,{owner:'bob',body:{draft:draft(),revision:1}})).status,409);
    assert.equal((await call(db,{owner:'bob',id:null,method:'GET'})).status,200);
    assert.deepEqual((await (await call(db,{owner:'bob',id:null,method:'GET'})).json()).drafts,[]);
    assert.equal((await call(db,{body:{draft:draft('draft-a','Phiên bản hai'),revision:1}})).status,200);
    assert.equal((await call(db,{body:{draft:draft('draft-a','Ghi đè cũ'),revision:1}})).status,409);
    const saved=await (await call(db,{method:'GET'})).json();
    assert.equal(saved.revision,2);assert.equal(saved.draft.content,'Phiên bản hai');
    assert.equal((await call(db,{owner:'bob',method:'GET'})).status,404);
  } finally { db.sqlite.close(); }
});
test('Pagination reaches every draft, including identical timestamps',async()=>{
  const db=database();
  try {
    const insert=db.sqlite.prepare('INSERT INTO drafts (owner,id,payload,revision,updated_at,shop_id) VALUES (?,?,?,?,?,?)');
    for(const id of ['draft-a','draft-b','draft-c']) insert.run('alice',id,JSON.stringify(draft(id)),1,1000,ctxFor('alice').shop.id);
    insert.run('bob','private',JSON.stringify(draft('private')),1,2000,ctxFor('bob').shop.id);
    let cursor='',ids=[];
    do {
      const response=await call(db,{id:null,method:'GET',query:'?limit=2'+(cursor?'&cursor='+encodeURIComponent(cursor):'')});
      assert.equal(response.status,200);
      const page=await response.json();
      ids.push(...page.drafts.map(row=>row.draft.id));cursor=page.nextCursor;
    } while(cursor);
    assert.deepEqual(ids,['draft-c','draft-b','draft-a']);
    assert.equal((await call(db,{id:null,method:'GET',query:'?cursor=broken'})).status,400);
    assert.equal((await call(db,{id:null,method:'GET',query:'?limit=0'})).status,400);
  } finally { db.sqlite.close(); }
});
test('Storage rejects malformed, unsupported or oversized payloads without writing',async()=>{
  const db=database();
  try {
    for(const [changes,status] of [[{content:' '},400],[{channels:['x','x']},400],[{media:[{url:'blob:temp'}]},422],[{assets:['asset']},422],[{custom:[]},422],[{custom:{facebook:{text:'custom'}}},422],[{scheduledAt:100},422]]) {
      assert.equal((await call(db,{body:{draft:{...draft(),...changes},revision:0}})).status,status,JSON.stringify(changes));
    }
    assert.equal((await call(db,{raw:'{'})).status,400);
    assert.equal((await call(db,{headers:{Origin:'https://evil.example'}})).status,403);
    assert.equal((await call(db,{raw:'x'.repeat(32769)})).status,413);
    assert.equal((await call(db,{body:{draft:draft(),revision:Number.MAX_SAFE_INTEGER}})).status,400);
    assert.equal((await call(undefined)).status,503);
    assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM drafts').get().n,0);
  } finally { db.sqlite.close(); }
});
test('Xóa bản nháp chỉ tác động đúng chủ sở hữu và từ chối ghi khác origin',async()=>{
  const db=database();
  try {
    assert.equal((await call(db)).status,200); // alice tạo draft-a
    // Chủ khác không xóa được bản nháp của alice: deleted=false, dữ liệu còn nguyên.
    const other=await call(db,{owner:'bob',method:'DELETE'});
    assert.equal(other.status,200);assert.equal((await other.json()).deleted,false);
    assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM drafts').get().n,1);
    // DELETE khác origin bị chặn như ghi.
    assert.equal((await call(db,{method:'DELETE',headers:{Origin:'https://evil.example'}})).status,403);
    // Thiếu id không cho DELETE.
    assert.equal((await call(db,{id:null,method:'DELETE'})).status,405);
    // Chủ sở hữu xóa thành công.
    const ok=await call(db,{method:'DELETE'});
    assert.equal(ok.status,200);assert.equal((await ok.json()).deleted,true);
    assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM drafts').get().n,0);
    // Xóa lại bản không còn: deleted=false.
    assert.equal((await (await call(db,{method:'DELETE'})).json()).deleted,false);
  } finally { db.sqlite.close(); }
});
test('Giới hạn tần suất chỉ áp cho ghi (PUT/DELETE), không áp cho đọc (GET)',async()=>{
  const db=database();
  try {
    const keys=[];
    const deny={limit:async v=>{keys.push(v.key);return {success:false}}};
    // GET không bị giới hạn ngay cả khi limiter từ chối.
    assert.equal((await call(db,{id:null,method:'GET',limiter:deny})).status,200);
    assert.equal((await call(db,{method:'GET',limiter:deny})).status,404); // chưa có bản nháp, nhưng không 429
    assert.equal(keys.length,0,'GET không được gọi limiter');
    // PUT bị giới hạn → 429 và dùng key drafts-write:<owner>.
    const put=await call(db,{limiter:deny});
    assert.equal(put.status,429);assert.equal(put.headers.get('Retry-After'),'60');
    // DELETE bị giới hạn → 429.
    assert.equal((await call(db,{method:'DELETE',limiter:deny})).status,429);
    assert.deepEqual(keys,['drafts-write:alice','drafts-write:alice']);
  } finally { db.sqlite.close(); }
});


test('Xung đột ID bản nháp giữa hai shop trả lỗi rõ ràng thay vì "đã thay đổi trên máy chủ"',async()=>{
  const db=database();
  try {
    // alice tạo draft-a trong shop A (ctxFor mặc định).
    assert.equal((await call(db)).status,200);
    // alice tạo cùng ID draft-a trong shop B (shop_id khác) → phải báo lỗi cross-shop.
    const shopBCtx={shop:{id:'s_shopBxxx'},membership:{role:'owner',can_publish:true},can:action=>can({role:'owner',can_publish:true},action)};
    const url='https://app.example/storage/drafts/draft-a';
    const req=new Request(url,{method:'PUT',headers:{Origin:'https://app.example','Content-Type':'application/json'},body:JSON.stringify({draft:draft(),revision:0})});
    const r=await drafts(req,{DB:db,AI_RATE_LIMITER:{limit:async()=>({success:true})}},
      'alice',json,shopBCtx);
    assert.equal(r.status,409);
    const body=await r.json();
    // Thông điệp phải đề cập "shop khác", không phải "đã thay đổi trên máy chủ".
    assert.ok(body.error.includes('shop khác'),'Thông điệp lỗi phải chỉ rõ xung đột cross-shop: '+body.error);
  } finally { db.sqlite.close(); }
});
