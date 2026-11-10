import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {runDueScheduledPosts} from '../src/channels.js';
test('concurrent cron invocations publish a scheduled Zalo article only once',async()=>{
 const sql=new DatabaseSync(':memory:');
 const prepare=(s,p=[])=>({bind:(...v)=>prepare(s,v),async run(){return {meta:{changes:Number(sql.prepare(s).run(...p).changes)}};},async all(){return {results:sql.prepare(s).all(...p)};},async first(){return sql.prepare(s).get(...p)||null;}});
 sql.exec("CREATE TABLE shops(id TEXT PRIMARY KEY,status TEXT);INSERT INTO shops VALUES('shop','active');CREATE TABLE audit_log(shop_id TEXT,actor TEXT,action TEXT,target TEXT,detail TEXT,created_at INTEGER);");
 const env={DB:{prepare:s=>prepare(s),async batch(stmts){return Promise.all(stmts.map(s=>s.run()));}},SOCIAL_TOKEN_KEY:Buffer.alloc(32,7).toString('base64'),ZALO_APP_SECRET:'fixture-app-secret'};
 await runDueScheduledPosts(env);
 sql.prepare("INSERT INTO channels(shop_id,provider,external_id,token,expires_at,status) VALUES('shop','zalo','123456789','fixture-token',?,'connected')").run(Math.floor(Date.now()/1000)+3600);
 sql.prepare("INSERT INTO scheduled_posts(id,shop_id,provider,content,images,run_at,status) VALUES('job','shop','zalo','Test',?,0,'scheduled')").run(JSON.stringify(['https://example.com/cover.png']));
 let creates=0;const original=globalThis.fetch;
 globalThis.fetch=async url=>{if(String(url).endsWith('/getoa'))return Response.json({error:0,data:{oa_id:'123456789'}});if(String(url).endsWith('/create')){creates++;return Response.json({error:0,data:{token:'article-token'}});}return Response.json({error:0,data:{id:'article-id'}});};
 try{await Promise.all([runDueScheduledPosts(env),runDueScheduledPosts(env)]);assert.equal(creates,1);assert.equal(sql.prepare('SELECT status FROM scheduled_posts').get().status,'posted');}
 finally{globalThis.fetch=original;sql.close();}
});
