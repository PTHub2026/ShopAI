import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';

// These historical ALTERs can already exist after lazy Worker initialization.
// Do not edit applied migration files or mark any other migration complete.
const repairs=[
 {name:'0010_publish_retry_after.sql',column:'next_attempt_at',type:'INTEGER',notnull:1,defaults:['0','(0)']},
 {name:'0014_instagram_container.sql',column:'instagram_container_id',type:'TEXT',notnull:0,defaults:[null]}
];
export async function reconcileRuntimeMigrations(db){
 const columns=(await db.prepare('PRAGMA table_info(publish_jobs)').all()).results;
 const present=repairs.filter(r=>columns.some(c=>c.name===r.column));
 for(const repair of present){
  const column=columns.find(c=>c.name===repair.column);
  if(column.type.toUpperCase()!==repair.type||column.notnull!==repair.notnull||!repair.defaults.includes(column.dflt_value))throw Error('Incompatible publish_jobs column: '+repair.column);
  const source=readFileSync(new URL('./migrations/'+repair.name,import.meta.url),'utf8').replace(/--[^\n]*/g,'').trim();
  const expected=repair.column==='next_attempt_at'?'ALTER TABLE publish_jobs ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;':'ALTER TABLE publish_jobs ADD COLUMN instagram_container_id TEXT;';
  if(source!==expected)throw Error('Migration changed. Review repair before proceeding: '+repair.name);
 }
 if(!present.length)return [];
 await db.prepare('CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)').run();
 const recorded=new Set((await db.prepare('SELECT name FROM d1_migrations').all()).results.map(r=>r.name));
 const missing=present.filter(r=>!recorded.has(r.name));
 if(missing.length)await db.batch(missing.map(r=>db.prepare("INSERT OR IGNORE INTO d1_migrations(name) VALUES('"+r.name+"')")));
 return missing.map(r=>r.name);
}

function run(){
 const args=process.argv.slice(2),options={};
 for(let i=0;i<args.length;i++){
  const key=args[i];
  if(!['--config','--database','--local','--remote'].includes(key)||options[key]!==undefined)throw Error('Use --config <file> --database <binding> and exactly one of --local or --remote.');
  options[key]=['--local','--remote'].includes(key)?true:args[++i];
 }
 if(!options['--config']||!options['--database']||Boolean(options['--local'])===Boolean(options['--remote']))throw Error('Explicit config, database and local/remote mode are required.');
 const config=JSON.parse(readFileSync(options['--config'],'utf8'));
 const binding=config.d1_databases?.find(d=>d.binding===options['--database']||d.database_name===options['--database']);
 if(!binding||binding.migrations_table&&binding.migrations_table!=='d1_migrations')throw Error('Use an explicit D1 binding with the default d1_migrations ledger.');
 const cli=fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url));
 const execute=sql=>{
  const result=JSON.parse(execFileSync(process.execPath,[cli,'d1','execute',options['--database'],'--config',options['--config'],options['--local']?'--local':'--remote','--json','--command',sql],{encoding:'utf8',env:{...process.env,WRANGLER_SEND_METRICS:'false'}}));
  if(!Array.isArray(result)||result.some(r=>r.success===false))throw Error('D1 schema query failed.');
  return result.at(-1);
 };
 const prepare=sql=>({sql,async all(){return execute(sql);},async run(){return execute(sql);}});
 return reconcileRuntimeMigrations({prepare,async batch(statements){execute(statements.map(s=>s.sql+';').join('\n'));}});
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 run().then(repaired=>console.log(JSON.stringify({reconciled:repaired}))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
