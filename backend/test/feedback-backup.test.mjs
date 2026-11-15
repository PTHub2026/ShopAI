import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sqliteDB} from './sqlite-fixture.mjs';
import {resolveShop} from '../src/shops.js';
const json=(b,status=200)=>Response.json(b,{status});
test('feedback is server owned, isolated, revision guarded and export denies viewers',async()=>{
 const {handleShopData}=await import('../src/shop-data.js');
 const env={DB:sqliteDB()},who={owner:'owner',email:'owner@example.com'},other={owner:'other',email:'other@example.com'};
 const ctx=await resolveShop(env,who,new Request('https://app.example/'));
 const call=(path,method='GET',body,user=who)=>handleShopData(new Request('https://app.example/api/'+path,{method,headers:{Origin:'https://app.example','X-ShopPost-Shop':ctx.shop.id,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env,user,json);
 try{
  const input={id:'fb-test',title:'Bug report',desc:'Details of the observed problem',type:'bug',prio:'high',page:'analytics',by:'User',email:'',shots:[],tech:null};
  const created=await call('feedback','POST',input);assert.equal(created.status,201);
  assert.equal((await call('feedback','POST',input)).status,200,'duplicate retry returns same record');
  assert.equal((await(await call('feedback')).json()).items.length,1);
  assert.equal((await call('feedback', 'GET',null,other)).status,404);
  const updated=await call('feedback/fb-test','PATCH',{revision:1,status:'doing',note:'Investigating'});assert.equal(updated.status,200);
  assert.equal((await call('feedback/fb-test','PATCH',{revision:1,status:'done'})).status,409);
  const backup=await(await call('backup?section=feedback')).json();assert.equal(backup.rows.length,1);assert.equal(JSON.parse(backup.rows[0].payload).status,'doing');
  env.DB.sqlite.prepare('UPDATE shop_members SET role=\'viewer\' WHERE shop_id=?').run(ctx.shop.id);
  assert.equal((await call('backup?section=feedback')).status,403);
  assert.equal((await call('feedback','POST',{...input,id:'viewer'})).status,403);
 }finally{env.DB.sqlite.close();}
});
