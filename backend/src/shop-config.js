import { readJson } from './auth.js';
import { ensureChannelStore } from './channel-store.js';
import { resolveShop } from './shops.js';
const fields = ['brand','signup','desc','audience','features','rules','tone'];
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
function valid(bucket, value) {
  if (bucket === 'settings') return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => fields.includes(k) && typeof value[k] === 'string' && value[k].length <= 20000);
  return Array.isArray(value) && value.length <= 200 && new Set(value.map(x => x?.id)).size === value.length && value.every(x => x && id(x.id) && typeof x.name === 'string' && x.name.trim() && x.name.length <= 240 && (bucket === 'hashtags'
    ? Array.isArray(x.tags) && x.tags.length <= 100 && x.tags.every(t => typeof t === 'string' && t.length <= 100)
    : typeof x.desc === 'string' && x.desc.length <= 1000 && /^#[a-f0-9]{6}$/i.test(x.color) && Array.isArray(x.channels) && x.channels.length <= 100 && x.channels.every(id)));
}
export async function handleShopConfig(request, env, who, json) {
  const bucket = new URL(request.url).pathname.slice('/api/shop-config/'.length);
  if (!['groups','hashtags','settings'].includes(bucket)) return json({error:'Không tìm thấy cấu hình.'},404);
  if (!request.headers.get('X-ShopPost-Shop')) return json({error:'Chọn shop trước.'},400);
  if (!['GET','PUT'].includes(request.method)) return json({error:'Phương thức không hỗ trợ.'},405);
  try {
    const context = await resolveShop(env,who,request);
    if(context.error) return json({error:context.error,code:context.code},context.status);
    if(!context.can(request.method === 'GET' ? 'shop.view' : bucket === 'hashtags' ? 'drafts.create' : 'shop.update')) return json({error:'Bạn không có quyền sửa cấu hình này.',code:'forbidden'},403);
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS shop_config (shop_id TEXT NOT NULL REFERENCES shops(id), bucket TEXT NOT NULL, revision TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(shop_id,bucket))').run();
    const key=[context.shop.id,bucket];
    const row=await env.DB.prepare('SELECT revision,payload FROM shop_config WHERE shop_id = ? AND bucket = ?').bind(...key).first();
    if(request.method==='GET') return json({bucket,revision:row?.revision??null,value:row?JSON.parse(row.payload):null});
    let body;try {body=await readJson(request,256*1024);}catch{return json({error:'Dữ liệu không hợp lệ.'},400);}
    if(!body || (body.revision!==null&&!id(body.revision)) || !valid(bucket,body.value)) return json({error:'Cấu hình không hợp lệ.'},422);
    if(bucket==='groups'){
      await ensureChannelStore(env.DB);
      const {results}=await env.DB.prepare('SELECT id,provider FROM channels WHERE shop_id = ?').bind(context.shop.id).all();
      const allowed=new Set(results.map(c=>c.provider==='zalo'?'real_zalo':'real_'+c.provider+'_'+c.id));
      if(body.value.some(g=>g.channels.some(channel=>!allowed.has(channel))))return json({error:'Nhóm chứa kênh không thuộc shop này.'},422);
    }
    if((row?.revision??null)!==body.revision) return json({error:'Cấu hình đã đổi trên thiết bị khác. Tải lại bản máy chủ trước khi sửa.',code:'config_conflict'},409);
    const revision=crypto.randomUUID(),payload=JSON.stringify(body.value);
    const result=await (row?env.DB.prepare('UPDATE shop_config SET revision = ?,payload = ? WHERE shop_id = ? AND bucket = ? AND revision = ?').bind(revision,payload,...key,body.revision):env.DB.prepare('INSERT INTO shop_config (shop_id,bucket,revision,payload) VALUES (?,?,?,?) ON CONFLICT DO NOTHING').bind(...key,revision,payload)).run();
    if(!result.meta.changes)return json({error:'Cấu hình đã đổi trên thiết bị khác.',code:'config_conflict'},409);
    return json({bucket,revision,value:body.value});
  }catch{return json({error:'Chưa truy cập được cấu hình máy chủ. Hãy thử lại.'},503);}
}
