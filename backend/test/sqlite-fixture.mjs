import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
export function sqliteDB(){
 const sqlite=new DatabaseSync(':memory:');
 for(const f of ['0001_drafts.sql','0002_auth.sql','0003_shops_roles.sql'])sqlite.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
 const prepare=(s,p=[])=>({bind:(...v)=>prepare(s,v),async first(){return sqlite.prepare(s).get(...p)||null;},async all(){return {results:sqlite.prepare(s).all(...p)};},async run(){return {meta:{changes:Number(sqlite.prepare(s).run(...p).changes)}};},exec(){return {meta:{changes:Number(sqlite.prepare(s).run(...p).changes)}};}});
 return {sqlite,prepare:s=>prepare(s),async batch(stmts){sqlite.exec('BEGIN');try{const r=stmts.map(s=>s.exec());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
}
