import {publishZaloArticle} from './channels.js';
import {publishMeta} from './meta.js';
import {decryptToken,callTelegram} from './social.js';
const enc=new TextEncoder(),clean=v=>typeof v==='string'?v.trim():'';
const MAX_IMAGE_BYTES=1048576,MAX_IMAGES=6;
export function validatePost(provider,p){
 const reject=(code,status=400)=>{throw Object.assign(Error(code),{code,status});};
 if(!p||!['text','photo'].includes(p.kind)||typeof p.text!=='string')reject('invalid_input');
 if(provider==='zalo'){
  if(!p.text.trim())reject('Thiếu nội dung bài viết để đăng.');
  if(p.text.length>20000)reject('invalid_input');
  if(!normalizeImages(p.images).length)reject('Bài viết Zalo cần ít nhất một ảnh bìa.');
  if(JSON.stringify(p.images).length>900000)reject('Ảnh đính kèm quá lớn để lên lịch.',413);
  return;
 }
 if(provider==='instagram'&&p.kind!=='photo')reject('instagram_requires_photo');
 if(provider==='facebook'){
  if(p.text.length>5000||(!p.text.trim()&&p.kind==='text'))reject('invalid_input');
  if(p.kind==='photo'&&p.images!==undefined){
   let images;try{images=normalizeImages(p.images);}catch(e){reject(e.message);}
   if(!images.length||JSON.stringify(p.images).length>6*1024*1024)reject('invalid_photo');
   if(images.some(i=>i.kind==='url'?!/^https:\/\//.test(i.url):!['image/jpeg','image/png','image/gif','image/webp'].includes(i.mime)))reject('invalid_photo');
   return;
  }
  if(p.kind==='text')return;
 }
 if(!['telegram','facebook','instagram'].includes(provider))reject('unsupported_provider');
 if(p.text.length>(provider==='facebook'?5000:p.kind==='photo'?1024:4096)||(!p.text.trim()&&p.kind==='text'))reject('invalid_input');
 if(p.kind==='photo'&&(typeof p.photoUrl!=='string'||!/^https:\/\/[^\s@/]+(?:\/[^\s]*)?$/.test(p.photoUrl)||p.photoUrl.length>2048))reject('invalid_photo');
}
export function retryDecision(e,attempt){
 if(e?.status===401||e?.status===403||e?.reauth)return {status:'failed',code:'provider_denied',reauth:true};
 if(!e?.deliveryUncertain&&(e?.status===429||e?.safeToRetry)){
  if(attempt>=5)return {status:'failed',code:'retry_exhausted'};
  // Deterministic exponential base with bounded jitter, never earlier than provider retry_after.
  const base=Math.min(3600,15*2**Math.min(attempt-1,8));
  return {status:'retryable',code:e.status===429?'rate_limited':'provider_unavailable',delay:Math.max(Math.ceil(Number(e.retryAfter)||0),base+Math.floor(Math.random()*Math.min(10,base)))};
 }
 if(e?.permanent||e?.code==='invalid_input')return {status:'failed',code:e.code||'invalid_input'};
 return {status:'unknown',code:'delivery_uncertain'};
}
export function providerFailure(r,message){
 const e=Error(message);e.status=r.status;e.providerCode=r.data?.error;
 // HTTP 429 is an explicit rate-limit rejection; opaque API codes are not guessed.
 e.retryAfter=Number(r.data?.retry_after)||0;
 return e;
}

export function normalizeImages(images) {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw new Error('Danh sách ảnh không hợp lệ.');
  if (images.length > MAX_IMAGES) throw new Error('Chỉ hỗ trợ tối đa ' + MAX_IMAGES + ' ảnh mỗi bài.');
  const out = [];
  for (const raw of images) {
    const item = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? (raw.data || raw.url || '') : '');
    const s = clean(item);
    if (!s) continue;
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(s);
    if (m) {
      const mime = clean(m[1]) || 'image/jpeg';
      if (!/^image\//i.test(mime)) throw new Error('Chỉ hỗ trợ tệp ảnh để đăng kèm.');
      let bytes;
      try { bytes = m[2] ? Uint8Array.from(atob(m[3]), c => c.charCodeAt(0)) : enc.encode(decodeURIComponent(m[3])); }
      catch { throw new Error('Dữ liệu ảnh không hợp lệ.'); }
      if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('Ảnh vượt quá 1MB; hãy dùng ảnh nhỏ hơn.');
      const ext = /png/i.test(mime) ? 'png' : /gif/i.test(mime) ? 'gif' : /webp/i.test(mime) ? 'webp' : 'jpg';
      out.push({ kind: 'upload', bytes, mime, name: 'image.' + ext });
    } else if (/^https?:\/\//i.test(s)) {
      out.push({ kind: 'url', url: s });
    } else {
      throw new Error('Ảnh phải là data URL hoặc đường dẫn http(s).');
    }
  }
  return out;
}


// Graph trả id dạng PAGEID_POSTID (bài văn bản) hoặc id số (ảnh); facebook.com/<id> chuyển tới đúng bài.
export function facebookPostUrl(id){return /^\d{1,30}(_\d{1,30})?$/.test(String(id))?'https://www.facebook.com/'+id:null;}
const publishers={
 async zalo(env,db,a,j){const p=JSON.parse(j.payload);const r=await publishZaloArticle(env,db,a,{content:p.text,title:p.title,images:p.images,author:p.author});return {id:String(r.id),url:r.url};},
 async telegram(env,db,a,j){const token=await decryptToken(env,a.token,a.token_iv),p=JSON.parse(j.payload);
 const r=j.kind==='text'?await callTelegram(token,'sendMessage',{chat_id:a.external_id,text:p.text}):await callTelegram(token,'sendPhoto',{chat_id:a.external_id,photo:p.photoUrl,caption:p.text});
 if(!Number.isSafeInteger(r?.message_id)||r.message_id<=0)throw Error('TELEGRAM_MISSING_MESSAGE_ID');return {id:String(r.message_id)};},
 async facebook(env,db,a,j){const id=await publishMeta(env,a,j);return {id,url:facebookPostUrl(id)};},
 async instagram(env,db,a,j){return {id:await publishMeta(env,a,j)};}
};
export async function publishFor(provider,env,db,account,job){
 if(!publishers[provider])throw Object.assign(Error('unsupported_provider'),{code:'invalid_input'});
 const payload=JSON.parse(job.payload);
 if(payload.externalId&&String(payload.externalId)!==String(account.external_id))throw Object.assign(Error('account_changed'),{code:'account_changed',permanent:true});
 try{validatePost(provider,{...payload,kind:job.kind});}catch(e){throw Object.assign(e,{permanent:true,code:'invalid_input'});}
 return publishers[provider](env,db,account,job);
}
