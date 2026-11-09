// One credential store for all providers. Legacy tables are retained as recovery snapshots.
export const CHANNEL_SCHEMA = `CREATE TABLE IF NOT EXISTS channels (
 id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), shop_id TEXT NOT NULL,
 provider TEXT NOT NULL CHECK(provider IN ('zalo','telegram','facebook','instagram')),
 external_id TEXT, name TEXT, token TEXT, token_iv TEXT, refresh_token TEXT,
 expires_at INTEGER, status TEXT NOT NULL DEFAULT 'connected', connected_by TEXT,
 created_at INTEGER, updated_at INTEGER, UNIQUE(shop_id,provider,external_id))`;
const ready=new WeakMap();
export async function ensureChannelStore(db){
 if(ready.has(db))return ready.get(db);
 const task=(async()=>{
  await db.prepare(CHANNEL_SCHEMA).run();
  await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS channels_zalo_shop ON channels(shop_id,provider) WHERE provider='zalo'").run();
  await db.prepare('CREATE INDEX IF NOT EXISTS channels_shop ON channels(shop_id,status)').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS channel_store_migrations(id TEXT PRIMARY KEY)').run();
  if(await db.prepare("SELECT id FROM channel_store_migrations WHERE id='unified-v1'").first())return;
  const {results}=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('shop_channels','social_accounts')").all();
  const names=new Set(results.map(r=>r.name)),steps=[];
  if(names.has('shop_channels'))steps.push(db.prepare("INSERT OR IGNORE INTO channels(id,shop_id,provider,external_id,name,token,refresh_token,expires_at,status,connected_by,created_at,updated_at) SELECT 'zalo:'||shop_id,shop_id,provider,external_id,name,access_token,refresh_token,expires_at,status,connected_by,connected_at,updated_at FROM shop_channels"));
  if(names.has('social_accounts'))steps.push(db.prepare("INSERT OR IGNORE INTO channels(id,shop_id,provider,external_id,name,token,token_iv,status,connected_by,created_at,updated_at) SELECT id,shop_id,provider,target_id,display_name,token_ciphertext,token_iv,CASE status WHEN 'active' THEN 'connected' WHEN 'revoked' THEN 'revoked' ELSE 'reauth_required' END,connected_by,created_at,updated_at FROM social_accounts"));
  steps.push(db.prepare("INSERT OR IGNORE INTO channel_store_migrations(id) VALUES('unified-v1')"));
  await db.batch(steps);
 })();ready.set(db,task);
 try{await task;}catch(e){ready.delete(db);throw e;}
}
