import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {sqliteDB} from './sqlite-fixture.mjs';
import {ensureSocialSchema} from '../src/social.js';
import {reconcileRuntimeMigrations} from '../reconcile-runtime-migrations.mjs';
const root=new URL('../migrations/',import.meta.url);
async function applyPending(db){
 db.sqlite.exec('CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
 // sqliteDB already applied the base schema, as recorded in an existing deployment.
 for(const name of ['0001_drafts.sql','0002_auth.sql','0003_shops_roles.sql'])db.sqlite.prepare('INSERT OR IGNORE INTO d1_migrations(name) VALUES(?)').run(name);
 for(const name of readdirSync(root).filter(n=>n.endsWith('.sql')).sort()){
  if(db.sqlite.prepare('SELECT name FROM d1_migrations WHERE name=?').get(name))continue;
  db.sqlite.exec(readFileSync(new URL(name,root),'utf8'));
  db.sqlite.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(name);
 }
}
test('runtime-first databases finish migrations without duplicate columns or lost jobs',async()=>{
 const db=sqliteDB();
 try{
  await ensureSocialSchema(db);
  db.sqlite.exec("INSERT INTO publish_jobs(id,shop_id,account_id,idempotency_key,kind,payload,status,created_by,created_at,updated_at) VALUES('saved','shop','a','key','text','{}','unknown','actor',1,1)");
  const repaired=await reconcileRuntimeMigrations(db);
  assert.deepEqual(repaired,['0010_publish_retry_after.sql','0014_instagram_container.sql']);
  await applyPending(db);
  assert.equal(db.sqlite.prepare("SELECT status FROM publish_jobs WHERE id='saved'").get().status,'unknown');
  assert.deepEqual(await reconcileRuntimeMigrations(db),[]);
 }finally{db.sqlite.close();}
});
test('migration-first and legacy databases retain normal ALTER migrations',async()=>{
 const db=sqliteDB();
 try{
  db.sqlite.exec(readFileSync(new URL('0008_social_publishing.sql',root),'utf8'));
  assert.deepEqual(await reconcileRuntimeMigrations(db),[]);
  await applyPending(db);await ensureSocialSchema(db);
  assert.ok(db.sqlite.prepare('PRAGMA table_info(publish_jobs)').all().some(c=>c.name==='next_attempt_at'));
  assert.deepEqual(await reconcileRuntimeMigrations(db),[]);
 }finally{db.sqlite.close();}
});
test('schema repair refuses an incompatible column instead of marking its migration applied',async()=>{
 const db=sqliteDB();
 try{
  db.sqlite.exec(readFileSync(new URL('0008_social_publishing.sql',root),'utf8'));
  db.sqlite.exec('ALTER TABLE publish_jobs ADD COLUMN next_attempt_at TEXT');
  await assert.rejects(reconcileRuntimeMigrations(db),/incompatible.*next_attempt_at/i);
  assert.equal(db.sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE name='d1_migrations'").get().n,0);
 }finally{db.sqlite.close();}
});
