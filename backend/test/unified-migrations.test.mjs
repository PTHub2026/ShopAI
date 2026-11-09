import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
test('unified migrations preserve legacy Zalo channels and add social publishing independently',()=>{
 const db=new DatabaseSync(':memory:');
 const root=new URL('../migrations/',import.meta.url);
 const files=readdirSync(root).filter(f=>f.endsWith('.sql')).sort();
 try{
  for(const file of files.filter(f=>f<'0008'))db.exec(readFileSync(new URL(file,root),'utf8'));
  db.exec("INSERT INTO shop_channels(shop_id,provider,external_id,name,status) VALUES('old-shop','zalo','old-oa','Existing OA','connected')");
  for(const file of files.filter(f=>f>='0008'))db.exec(readFileSync(new URL(file,root),'utf8'));
  assert.equal(db.prepare('SELECT external_id FROM channels').get().external_id,'old-oa');
  assert.ok(db.prepare('PRAGMA table_info(publish_jobs)').all().some(c=>c.name==='next_attempt_at'));
  for(const table of ['shop_channels','scheduled_posts','channels','publish_jobs','meta_oauth_states'])assert.equal(db.prepare('SELECT count(*) n FROM sqlite_master WHERE type=? AND name=?').get('table',table).n,1);
 }finally{db.close();}
});

test('runtime migration preserves both credential formats and never resurrects deleted channels',async()=>{
 const {ensureChannelStore}=await import('../src/channel-store.js');
 const {sqliteDB}=await import('./sqlite-fixture.mjs');const db=sqliteDB();
 try{
  db.sqlite.exec(readFileSync(new URL('../migrations/0005_channels.sql',import.meta.url),'utf8'));
  db.sqlite.exec(readFileSync(new URL('../migrations/0008_social_publishing.sql',import.meta.url),'utf8'));
  db.sqlite.exec("INSERT INTO shop_channels(shop_id,provider,external_id,name,access_token,refresh_token,status) VALUES('shop','zalo','123456','OA','enc1.iv.encrypted','enc1.iv.refresh','connected')");
  db.sqlite.exec("INSERT INTO social_accounts(id,shop_id,provider,display_name,target_id,token_ciphertext,token_iv,status,connected_by,created_at,updated_at) VALUES('sa_old','shop','telegram','Bot','-12345','encrypted-cipher','encrypted-iv','active','actor',1,1)");
  await ensureChannelStore(db);
  assert.equal(db.sqlite.prepare("SELECT token FROM channels WHERE provider='zalo'").get().token,'enc1.iv.encrypted');
  const bot=db.sqlite.prepare("SELECT token,token_iv,status FROM channels WHERE id='sa_old'").get();assert.equal(bot.token,'encrypted-cipher');assert.equal(bot.token_iv,'encrypted-iv');assert.equal(bot.status,'connected');
  db.sqlite.exec('DELETE FROM channels');
  // A fresh D1 binding (new isolate) must respect the durable migration marker.
  await ensureChannelStore({prepare:db.prepare,batch:db.batch});
  assert.equal(db.sqlite.prepare('SELECT count(*) n FROM channels').get().n,0);
 }finally{db.sqlite.close();}
});

test('Instagram checkpoint migration preserves an existing job and runtime initialization is repeatable',async()=>{
 const {sqliteDB}=await import('./sqlite-fixture.mjs');
 const {ensureSocialSchema}=await import('../src/social.js');const db=sqliteDB();
 const root=new URL('../migrations/',import.meta.url);
 try{
  for(const name of readdirSync(root).filter(f=>f.endsWith('.sql')&&f>='0004'&&f<'0014').sort())db.sqlite.exec(readFileSync(new URL(name,root),'utf8'));
  db.sqlite.exec("INSERT INTO publish_jobs(id,shop_id,account_id,idempotency_key,kind,payload,status,created_by,created_at,updated_at) VALUES('existing','shop','account','existing-key','photo','{}','retryable','actor',1,1)");
  db.sqlite.exec(readFileSync(new URL('0014_instagram_container.sql',root),'utf8'));
  await ensureSocialSchema(db);await ensureSocialSchema({prepare:db.prepare,batch:db.batch});
  const row=db.sqlite.prepare("SELECT status,payload,instagram_container_id FROM publish_jobs WHERE id='existing'").get();
  assert.equal(row.status,'retryable');assert.equal(row.payload,'{}');assert.equal(row.instagram_container_id,null);
 }finally{db.sqlite.close();}
});
