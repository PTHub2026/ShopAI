import { resolveShop, audit } from './shops.js';

const PROVIDERS = {facebook:'Facebook',tiktok:'TikTok',youtube:'YouTube',instagram:'Instagram',zalo:'Zalo OA',telegram:'Telegram',x:'X',linkedin:'LinkedIn',threads:'Threads'};
const DEFAULT_SETTINGS = {brand:'ShopTrack',signup:'',open:8,close:22,slaMin:15,timeZone:'Asia/Ho_Chi_Minh'};
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const OBJECT = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };
const string = (value,max,required=false) => typeof value === 'string' && value.length <= max && (!required || value.trim().length > 0);
const normalize = value => String(value || '').normalize('NFD').replace(/\p{M}/gu,'').replace(/đ/g,'d').replace(/Đ/g,'D').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const keywordMatch = (text,keywords) => String(keywords || '').split(',').some(k => {const n=normalize(k);return n && (' '+text+' ').includes(' '+n+' ');});

// Deliberately bounded regex language: up to 20 literal alternatives, optional ^/$ anchors.
// No groups, classes, wildcards, quantifiers, backreferences, lookarounds or flags.
// Escapes are allowed only for literal regex punctuation. Matching is O(alternatives * text).
function safeRegex(pattern) {
  if (!string(pattern,500,true)) fail('Regex phải có từ 1 đến 500 ký tự.');
  const parts=pattern.split('|');
  if (parts.length>20) fail('Regex chỉ hỗ trợ tối đa 20 lựa chọn văn bản.');
  const escaped=parts.map(part=>{
    const start=part.startsWith('^'),end=part.endsWith('$') && !part.endsWith('\\$');
    let value=part.slice(start?1:0,end?-1:undefined),literal='';
    for(let i=0;i<value.length;i++){
      if(value[i]==='\\') { if(i+1>=value.length || !'.*+?()[]{}^$\\'.includes(value[i+1])) fail('Regex chỉ hỗ trợ văn bản, |, ^, $ và ký tự đặc biệt được escape.');literal+=value[++i]; }
      else {if('.*+?()[]{}^$'.includes(value[i])) fail('Regex chỉ hỗ trợ văn bản, |, ^, $ và ký tự đặc biệt được escape.');literal+=value[i];}
    }
    if(!literal) fail('Regex không được có lựa chọn rỗng.');
    return (start?'^':'')+literal.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+(end?'$':'');
  });
  return new RegExp(escaped.map(p=>'(?:'+p+')').join('|'),'iu');
}

function validateDocument(body) {
  if(!OBJECT(body) || !Array.isArray(body.scripts) || body.scripts.length>100 || !OBJECT(body.settings)) fail('Cấu hình phải có scripts (tối đa 100) và settings.');
  const ids=new Set();
  const scripts=body.scripts.map(s=>{
    if(!OBJECT(s)||typeof s.id!=='string'||!ID.test(s.id)||ids.has(s.id)||!string(s.name,100,true)||!Number.isInteger(s.priority)||s.priority < 0||s.priority>10000||typeof s.on!=='boolean'||!['keyword','regex','welcome','offhours','fallback'].includes(s.trigger)||!string(s.keywords,2000)||!string(s.reply,4000,true)||!string(s.quick,2000)||!['none','tag','handoff','close'].includes(s.action)||!string(s.tagName,100)||!Array.isArray(s.channels)||s.channels.length>9||new Set(s.channels).size!==s.channels.length||s.channels.some(p=>!Object.hasOwn(PROVIDERS,p))) fail('Kịch bản không hợp lệ: kiểm tra mã, tên, nội dung, ưu tiên, hành động và kênh.');
    if(s.trigger==='keyword'&&!s.keywords.split(',').some(k=>normalize(k))) fail('Cần nhập từ khóa.');
    if(s.trigger==='regex')safeRegex(s.keywords);
    if(s.action==='tag'&&!s.tagName.trim())fail('Hành động gắn nhãn cần tên nhãn.');
    if(s.quick.split(',').map(q=>q.trim()).filter(Boolean).length>13 || s.quick.split(',').some(q=>q.trim().length>100))fail('Tối đa 13 trả lời nhanh, mỗi mục 100 ký tự.');
    ids.add(s.id);
    return Object.fromEntries(['id','name','priority','on','trigger','keywords','reply','quick','action','tagName','channels'].map(k=>[k,s[k]]));
  });
  const s=body.settings;
  if(!string(s.brand,100,true)||!string(s.signup,2048)||!Number.isFinite(s.open)||s.open<0||s.open>=24||!Number.isFinite(s.close)||s.close<0||s.close>24||s.open===s.close||!Number.isInteger(s.slaMin)||s.slaMin<1||s.slaMin>1440||s.timeZone!=='Asia/Ho_Chi_Minh') fail('Cài đặt không hợp lệ: giờ mở 0–<24, đóng 0–24 khác giờ mở, SLA 1–1440 phút và múi giờ Asia/Ho_Chi_Minh.');
  return {scripts,settings:Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(k=>[k,s[k]]))};
}

export async function ensureReplySchema(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS reply_configs (shop_id TEXT PRIMARY KEY, document TEXT NOT NULL, revision INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL)').run();
}

export function matchReply(scripts,settings,input={}) {
  if(input.paused)return null;
  const text=String(input.text || '').slice(0,10000),normalized=normalize(text);
  const active=scripts.filter(s=>s.on && (!s.channels.length||s.channels.includes(input.provider))).sort((a,b)=>a.priority-b.priority);
  const date=new Date(input.now ?? Date.now());
  if(!Number.isFinite(date.getTime()))return null;
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Ho_Chi_Minh',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date);
  const hour=Number(parts.find(p=>p.type==='hour').value)+Number(parts.find(p=>p.type==='minute').value)/60;
  const inside=settings.open<settings.close ? hour>=settings.open&&hour<settings.close : hour>=settings.open||hour<settings.close;
  const off=typeof input.forceOff==='boolean'?input.forceOff:!inside;
  const hit=active.find(s=>s.trigger==='offhours'&&off || s.trigger==='welcome'&&input.firstMessage===true || s.trigger==='keyword'&&keywordMatch(normalized,s.keywords) || s.trigger==='regex'&&(()=>{try{return safeRegex(s.keywords).test(text);}catch{return false;}})()) || active.find(s=>s.trigger==='fallback');
  if(!hit)return null;
  const vars={ten:input.name||'bạn',shop:settings.brand,kenh:PROVIDERS[input.provider]||input.provider||'',gio_mo:`${settings.open}h–${settings.close}h`,dang_ky:settings.signup};
  const fill=value=>value.replace(/\{(ten|shop|kenh|gio_mo|dang_ky)\}/g,(_,key)=>vars[key]);
  const result={scriptId:hit.id,scriptName:hit.name,text:fill(hit.reply),quick:hit.quick.split(',').map(q=>q.trim()).filter(Boolean).map(fill),action:hit.action,tagName:hit.tagName};
  if(hit.trigger==='offhours'){
    const extra=active.find(s=>s.trigger==='keyword'&&s.action==='handoff'&&keywordMatch(normalized,s.keywords));
    if(extra){result.text+='\n\n'+fill(extra.reply);result.extraAction={scriptId:extra.id,scriptName:extra.name,action:'handoff',tagName:extra.tagName};}
  }
  return result;
}

async function readBody(req) {
  if((req.headers.get('Content-Type')||'').split(';')[0].trim().toLowerCase()!=='application/json')throw {status:415,message:'Cần gửi application/json.'};
  const reader=req.body?.getReader();if(!reader)throw {status:400,message:'Thiếu JSON.'};
  const chunks=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>524288){await reader.cancel();throw {status:413,message:'Cấu hình vượt giới hạn 512 KB.'};}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try{const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!OBJECT(body))throw Error();return body;}catch{throw {status:400,message:'JSON không hợp lệ.'};}
}

export async function handleReplies(req,env,who,json) {
  const url=new URL(req.url),preview=url.pathname==='/api/replies/preview';
  if(!preview&&url.pathname!=='/api/replies/config')return json({error:'Không tìm thấy đường dẫn.'},404);
  const allowed=preview?['POST']:['GET','PUT'];
  if(!allowed.includes(req.method))return json({error:'Phương thức không hỗ trợ.'},405,{Allow:allowed.join(', ')});
  if(!env.DB)return json({error:'Chưa gắn cơ sở dữ liệu.'},503);
  if(!who?.owner)return json({error:'Cần đăng nhập.'},401);
  if(req.method!=='GET'&&req.headers.get('Origin')!==url.origin)return json({error:'Chỉ cho phép ghi từ cùng origin.'},403);
  try{
    const ctx=await resolveShop(env,who,req);if(ctx.error)return json({error:ctx.error,code:ctx.code},ctx.status);
    const canEdit=ctx.can('drafts.create')||ctx.can('channels.configure_token');
    if(!(ctx.can('drafts.view')||ctx.can('conversations.reply'))||req.method==='PUT'&&!canEdit)return json({error:'Bạn không có quyền với kịch bản của shop này.',code:'forbidden'},403);
    if(req.method!=='GET'){
      let limit;try{limit=await env.AI_RATE_LIMITER?.limit({key:'replies-write:'+who.owner});}catch{}
      if(!limit||typeof limit.success!=='boolean')return json({error:'Dịch vụ giới hạn yêu cầu chưa khả dụng.'},503);
      if(!limit.success)return json({error:'Quá nhiều yêu cầu.'},429,{'Retry-After':'60'});
    }
    await ensureReplySchema(env.DB);
    const shopId=ctx.shop.id;
    if(req.method==='GET'||preview){
      const row=await env.DB.prepare('SELECT document,revision FROM reply_configs WHERE shop_id = ?').bind(shopId).first();
      const document=row?JSON.parse(row.document):{scripts:[],settings:{...DEFAULT_SETTINGS}};
      if(!preview){await audit(env.DB,{shopId,actor:who.owner,action:'replies.read',detail:{revision:row?.revision||0}});return json({...document,revision:row?.revision||0,canEdit});}
      let input;try{input=await readBody(req);}catch(e){return json({error:e.message},e.status||400);}
      if(!string(input.text,10000)||('name'in input&&!string(input.name,100))||!Object.hasOwn(PROVIDERS,input.provider)||('now'in input&&(!Number.isSafeInteger(input.now)||!Number.isFinite(new Date(input.now).getTime())))||['firstMessage','forceOff','paused'].some(k=>k in input&&typeof input[k]!=='boolean'))return json({error:'Dữ liệu mô phỏng không hợp lệ.'},400);
      return json({reply:matchReply(document.scripts,document.settings,input),sent:false});
    }
    let body,document;
    try{body=await readBody(req);document=validateDocument(body);if(!Number.isSafeInteger(body.revision)||body.revision<0||body.revision>=Number.MAX_SAFE_INTEGER)fail('Phiên bản không hợp lệ.');}catch(e){return json({error:e.message},e.status||400);}
    const now=Date.now(),payload=JSON.stringify(document);
    const write=body.revision===0?env.DB.prepare('INSERT INTO reply_configs (shop_id,document,revision,updated_by,updated_at) VALUES (?,?,1,?,?) ON CONFLICT(shop_id) DO NOTHING').bind(shopId,payload,who.owner,now):env.DB.prepare('UPDATE reply_configs SET document=?,revision=revision+1,updated_by=?,updated_at=? WHERE shop_id=? AND revision=?').bind(payload,who.owner,now,shopId,body.revision);
    const result=await write.run();
    if(result.meta.changes!==1)return json({error:'Cấu hình đã thay đổi. Tải lại trước khi lưu.',code:'revision_conflict'},409);
    await audit(env.DB,{shopId,actor:who.owner,action:'replies.update',detail:{revision:body.revision+1,scriptCount:document.scripts.length}});
    return json({...document,revision:body.revision+1,canEdit});
  }catch{return json({error:'Không thể truy cập cấu hình kịch bản; chưa xác nhận đã lưu.'},503);}
}
