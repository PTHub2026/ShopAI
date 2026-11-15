import {readJson} from './auth.js';
import {resolveShop,audit} from './shops.js';
const ID=/^[A-Za-z0-9_-]{1,100}$/;
const text=(v,n)=>typeof v==='string'&&v.length<=n;
const schema=`CREATE TABLE IF NOT EXISTS shop_feedback(shop_id TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,revision INTEGER NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(shop_id,id))`;
const sections={
 settings:['shop_config','bucket,revision,payload'],
 chatbot:['reply_configs','document,revision,updated_at'],
 feedback:['shop_feedback','id,payload,revision,created_by,created_at,updated_at'],
 drafts:['drafts','id,payload,revision,updated_at'],
 library:['shop_library','bucket,id,revision,payload,file_type,file_size'],
 history:['publish_jobs','id,account_id,kind,payload,status,attempts,remote_message_id,error_code,created_at,updated_at'],
 channels:['channels','id,provider,name,external_id,status'],
};
export async function handleShopData(req,env,who,json){
 const url=new URL(req.url),isBackup=url.pathname==='/api/backup';
 if(!env.DB)return json({error:'Chưa có cơ sở dữ liệu.'},503);
 if(!req.headers.get('X-ShopPost-Shop'))return json({error:'Chọn shop trước.'},400);
 if(req.method!=='GET'&&req.headers.get('Origin')!==url.origin)return json({error:'Chỉ cho phép cùng origin.'},403);
 const ctx=await resolveShop(env,who,req);if(ctx.error)return json({error:ctx.error},ctx.status);
 if(!ctx.can('shop.view'))return json({error:'Không có quyền xem.'},403);
 if(isBackup){
  if(req.method!=='GET')return json({error:'Chỉ hỗ trợ GET.'},405);
  if(!ctx.can('shop.update'))return json({error:'Chỉ chủ shop hoặc quản lý được xuất dữ liệu.'},403);
  const section=url.searchParams.get('section'),cursor=Number(url.searchParams.get('cursor')||0);
  if(!Object.hasOwn(sections,section)||!Number.isSafeInteger(cursor)||cursor<0)return json({error:'Phần sao lưu không hợp lệ.'},400);
  const [table,columns]=sections[section];
  const exists=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(table).first();
  const results=exists?(await env.DB.prepare(`SELECT rowid AS exportCursor,${columns} FROM ${table} WHERE shop_id=? AND rowid>? ORDER BY rowid LIMIT 51`).bind(ctx.shop.id,cursor).all()).results:[];
  const rows=results.slice(0,50);return json({version:1,shop:{id:ctx.shop.id,name:ctx.shop.name},section,rows,cursor:results.length>50?rows.at(-1).exportCursor:null,exportedAt:Date.now(),excludes:['credentials','sessions','original_file_bytes','customer_conversations']});
 }
 if(!/^\/api\/feedback(?:\/[A-Za-z0-9_-]{1,100})?$/.test(url.pathname))return json({error:'Không tìm thấy.'},404);
 await env.DB.prepare(schema).run();
 const id=url.pathname.split('/')[3];
 if(req.method==='GET'&&!id){
  const cursor=url.searchParams.get('cursor')||'';if(cursor&&!ID.test(cursor))return json({error:'Con trỏ không hợp lệ.'},400);
  const {results}=await env.DB.prepare('SELECT id,payload,revision FROM shop_feedback WHERE shop_id=? AND id>? ORDER BY id LIMIT 51').bind(ctx.shop.id,cursor).all();
  const rows=results.slice(0,50);return json({items:rows.map(r=>({...JSON.parse(r.payload),revision:r.revision})),cursor:results.length>50?rows.at(-1).id:null,canManage:ctx.can('shop.update'),canCreate:ctx.can('drafts.create')||ctx.can('conversations.reply')});
 }
 const manage=ctx.can('shop.update');
 if(ctx.shop.status!=='active'||!(manage||ctx.can('drafts.create')||ctx.can('conversations.reply')))return json({error:'Không có quyền chỉnh sửa.'},403);
 if(req.method!=='POST'&&req.method!=='PATCH')return json({error:'Phương thức không hỗ trợ.'},405);
 let body;try{body=await readJson(req,1024*1024);}catch{return json({error:'Dữ liệu không hợp lệ hoặc vượt 1 MB.'},400);}
 if(!body||typeof body!=='object'||Array.isArray(body))return json({error:'Dữ liệu không hợp lệ.'},422);
 const now=Date.now();
 if(req.method==='POST'&&!id){
  if(!ID.test(body.id||'')||!text(body.title,240)||body.title.trim().length<5||!text(body.desc,10000)||body.desc.trim().length<10||!['bug','feature','ux','content','other'].includes(body.type)||!['low','mid','high','urgent'].includes(body.prio)||!text(body.page,50)||!text(body.by,100)||!text(body.email,254)||!Array.isArray(body.shots)||body.shots.length>3||body.shots.some(s=>!text(s,300000)||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s)))return json({error:'Góp ý không hợp lệ; tối đa 3 ảnh, mỗi ảnh 300 KB dạng dữ liệu.'},422);
  const tech=body.tech?Object.fromEntries(['ua','screen','route','storage','at'].filter(k=>text(body.tech[k],300)).map(k=>[k,body.tech[k]])):null;
  const item={...Object.fromEntries(['id','title','desc','type','prio','page','by','email','shots'].map(k=>[k,body[k]])),tech,status:'new',created:now,updated:now,notes:[]};
  const result=await env.DB.prepare('INSERT INTO shop_feedback VALUES(?,?,?,1,?,?,?) ON CONFLICT DO NOTHING').bind(ctx.shop.id,body.id,JSON.stringify(item),who.owner,now,now).run();
  const saved=await env.DB.prepare('SELECT payload,revision,created_by FROM shop_feedback WHERE shop_id=? AND id=?').bind(ctx.shop.id,body.id).first();
  if(!result.meta.changes&&(saved.created_by!==who.owner||JSON.parse(saved.payload).title!==body.title||JSON.parse(saved.payload).desc!==body.desc))return json({error:'Mã góp ý đã tồn tại.'},409);
  return json({item:{...JSON.parse(saved.payload),revision:saved.revision}},result.meta.changes?201:200);
 }
 if(req.method==='PATCH'&&id){
  if(!manage)return json({error:'Chỉ chủ shop hoặc quản lý được cập nhật xử lý.'},403);
  if(!Number.isSafeInteger(body.revision)||body.revision<1||body.status!==undefined&&!['new','doing','done','rejected'].includes(body.status)||body.note!==undefined&&!text(body.note,2000))return json({error:'Cập nhật không hợp lệ.'},422);
  const row=await env.DB.prepare('SELECT payload,revision FROM shop_feedback WHERE shop_id=? AND id=?').bind(ctx.shop.id,id).first();if(!row)return json({error:'Không tìm thấy góp ý.'},404);
  if(row.revision!==body.revision)return json({error:'Góp ý đã đổi. Tải lại trước khi lưu.'},409);
  const item=JSON.parse(row.payload);if(item.notes.length>=100)return json({error:'Đã đạt 100 ghi chú.'},422);
  if(body.status){item.status=body.status;item.closed=['done','rejected'].includes(body.status)?now:null;}
  if(body.note?.trim())item.notes.push({by:who.owner,t:now,text:body.note.trim()});item.updated=now;
  const result=await env.DB.prepare('UPDATE shop_feedback SET payload=?,revision=revision+1,updated_at=? WHERE shop_id=? AND id=? AND revision=?').bind(JSON.stringify(item),now,ctx.shop.id,id,body.revision).run();if(result.meta.changes!==1)return json({error:'Góp ý đã đổi. Tải lại trước khi lưu.'},409);
  await audit(env.DB,{shopId:ctx.shop.id,actor:who.owner,action:'feedback.update',target:id});return json({item:{...item,revision:row.revision+1}});
 }
 return json({error:'Không tìm thấy.'},404);
}
