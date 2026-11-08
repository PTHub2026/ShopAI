import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { drafts } from '../src/drafts.js';

// Real SQL/schema; adapt only the D1 asynchronous result envelope.
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_drafts.sql', import.meta.url), 'utf8'));
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
function call(DB, {owner='alice', id='draft-a', method='PUT', body={draft:draft(id),revision:0}, query='', headers={}, raw}={}) {
  const url='https://app.example/storage/drafts'+(id ? '/'+id : '')+query;
  return drafts(new Request(url, { method, headers:{Origin:'https://app.example','Content-Type':'application/json',...headers}, ...(method==='GET'?{}:{body:raw ?? JSON.stringify(body)}) }), { DB, AI_RATE_LIMITER:{limit:async()=>({success:true})} }, owner, json);
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
    const insert=db.sqlite.prepare('INSERT INTO drafts VALUES (?,?,?,?,?)');
    for(const id of ['draft-a','draft-b','draft-c']) insert.run('alice',id,JSON.stringify(draft(id)),1,1000);
    insert.run('bob','private',JSON.stringify(draft('private')),1,2000);
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
