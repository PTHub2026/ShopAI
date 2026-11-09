import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {runDueScheduledPosts} from '../src/channels.js';
test('concurrent cron invocations publish a scheduled Zalo article only once',async()=>{
 const sql=new DatabaseSync(':memory:');
 const prepare=(s,p=[])=>({bind:(...v)=>prepare(s,v),async run(){return {meta:{changes:Number(sql.prepare(s).run(...p).changes)}};},async all(){return {results:sql.prepare(s).all(...p)};},async first(){return sql.prepare(s).get(...p)||null;}});
 const env={DB:{prepare:s=>prepare(s)},SOCIAL_TOKEN_KEY:Buffer.alloc(32,7).toString('base64')};
 await runDueScheduledPosts(env);
 sql.prepare("INSERT INTO shop_channels(shop_id,provider,access_token,expires_at,status) VALUES('shop','zalo','fixture-token',?,'connected')").run(Math.floor(Date.now()/1000)+3600);
 sql.prepare("INSERT INTO scheduled_posts(id,shop_id,provider,content,images,run_at,status) VALUES('job','shop','zalo','Test',?,0,'scheduled')").run(JSON.stringify(['https://example.com/cover.png']));
 let creates=0;const original=globalThis.fetch;
 globalThis.fetch=async url=>{if(String(url).endsWith('/create')){creates++;return Response.json({error:0,data:{token:'article-token'}});}return Response.json({error:0,data:{id:'article-id'}});};
 try{await Promise.all([runDueScheduledPosts(env),runDueScheduledPosts(env)]);assert.equal(creates,1);assert.equal(sql.prepare('SELECT status FROM scheduled_posts').get().status,'posted');}
 finally{globalThis.fetch=original;sql.close();}
});
