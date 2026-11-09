import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';

test('Authenticated Worker reads/writes real local D1 and rejects stale revisions', {timeout:30000}, async()=>{
  const {subtle}=webcrypto;
  const pair=await subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const key={...await subtle.exportKey('jwk',pair.publicKey),kid:'integration-key',use:'sig',alg:'RS256'};
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  async function jwt(sub){const data=encode({alg:'RS256',kid:key.kid})+'.'+encode({iss:'https://integration.cloudflareaccess.com',aud:['integration-aud'],sub,exp:Math.floor(Date.now()/1000)+3600});return data+'.'+Buffer.from(await subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,Buffer.from(data))).toString('base64url')}
  const bundled=await build({entryPoints:[new URL('../src/worker.js',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'browser'});
  const mf=new Miniflare(convertV4MiniflareOptions({
    modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-11-07',cf:false,
    bindings:{ACCESS_TEAM_DOMAIN:'integration.cloudflareaccess.com',ACCESS_AUD:'integration-aud',AI:{},FRONTEND_HTML:readFileSync(new URL('../../index.html',import.meta.url),'utf8')},
    d1Databases:{DB:'integration-drafts'},ratelimits:{AI_RATE_LIMITER:{namespace_id:'1001',simple:{limit:100,period:60}}},
    outboundService:async request=>{assert.equal(request.url,'https://integration.cloudflareaccess.com/cdn-cgi/access/certs');return Response.json({keys:[key]})}
  }));
  try {
    const db=await mf.getD1Database('DB');
    await db.exec(readFileSync(new URL('../migrations/0001_drafts.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').replace(/\s+/g,' '));
    const alice=await jwt('alice'),bob=await jwt('bob');
    const fetch=(path,options={},token=alice)=>mf.dispatchFetch('https://app.example'+path,{...options,headers:{Origin:'https://app.example','Content-Type':'application/json','Cf-Access-Jwt-Assertion':token,...options.headers}});
    const login=await mf.dispatchFetch('https://app.example/');assert.equal(login.status,200);assert.doesNotMatch(await login.text(),/shopai-user-scope/);
    assert.equal((await mf.dispatchFetch('https://app.example/storage/drafts')).status,401);
    const page=await fetch('/');assert.equal(page.status,200);assert.match(await page.text(),/shopai-user-scope/);
    const body=JSON.stringify({draft:{id:'integration-a',type:'post',content:'Dữ liệu thử nghiệm D1 cục bộ',channels:[],status:'draft'},revision:0});
    const saved=await fetch('/storage/drafts/integration-a',{method:'PUT',body});assert.equal(saved.status,200);assert.equal((await saved.json()).revision,1);
    assert.equal((await fetch('/storage/drafts/integration-a',{method:'PUT',body})).status,409);
    const read=await fetch('/storage/drafts/integration-a');assert.equal(read.status,200);assert.equal((await read.json()).draft.content,'Dữ liệu thử nghiệm D1 cục bộ');
    assert.equal((await fetch('/storage/drafts/integration-a',{},bob)).status,404);
    assert.deepEqual((await (await fetch('/storage/drafts',{},bob)).json()).drafts,[]);
  } finally {await mf.dispose()}
});
