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
  assert.equal(db.prepare('SELECT external_id FROM shop_channels').get().external_id,'old-oa');
  assert.ok(db.prepare('PRAGMA table_info(publish_jobs)').all().some(c=>c.name==='next_attempt_at'));
  for(const table of ['shop_channels','scheduled_posts','social_accounts','publish_jobs','meta_oauth_states'])assert.equal(db.prepare('SELECT count(*) n FROM sqlite_master WHERE type=? AND name=?').get('table',table).n,1);
 }finally{db.close();}
});
