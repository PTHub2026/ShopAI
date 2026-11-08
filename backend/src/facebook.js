// OAuth connection only. Publishing, scheduling and inbox remain separate gates.
const VERSION = 'v27.0';
const SCOPES = ['pages_show_list'];
const encoder = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const hash = async value => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
const base64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
function keyBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw Error('KEY');
  const bytes=Uint8Array.from(atob(value), c=>c.charCodeAt(0));
  if (bytes.length !== 32) throw Error('KEY');
  return bytes;
}
function configured(env, origin) {
  try {
    keyBytes(env.CHANNEL_TOKEN_KEY);
    const app = new URL(env.APP_ORIGIN);
    return env.FACEBOOK_OAUTH_ENABLED === 'true' && Boolean(env.DB) && app.origin === env.APP_ORIGIN && app.protocol === 'https:' && app.origin === origin && /^\d{5,32}$/.test(env.FACEBOOK_APP_ID || '') && typeof env.FACEBOOK_APP_SECRET === 'string' && env.FACEBOOK_APP_SECRET.length >= 8 && (!env.FACEBOOK_CONFIG_ID || (/^\d{5,32}$/.test(env.FACEBOOK_CONFIG_ID) && env.FACEBOOK_CONFIG_SCOPES === 'pages_show_list'));
  } catch { return false; }
}
async function sealToken(token, secret, owner, page) {
  const key = await crypto.subtle.importKey('raw', keyBytes(secret), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(JSON.stringify([owner,page]))}, key, encoder.encode(token));
  return JSON.stringify({v:1,iv:base64(iv),data:base64(encrypted)});
}
export async function openToken(ciphertext, secret, owner, page) {
  const {v,iv,data}=JSON.parse(ciphertext);
  if(v!==1)throw Error('CIPHER');
  const key=await crypto.subtle.importKey('raw',keyBytes(secret),'AES-GCM',false,['decrypt']);
  const bytes=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(iv),additionalData:encoder.encode(JSON.stringify([owner,page]))},key,bytes(data)));
}
async function graph(path, token, params = {}) {
  // Only the fixed Graph origin. Never follow provider-supplied pagination URLs or redirects.
  const url = new URL(`https://graph.facebook.com/${VERSION}/${path}`);
  for (const [key,value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url.href, {headers:token ? {Authorization:`Bearer ${token}`} : {},redirect:'manual',signal:AbortSignal.timeout(15000)});
  if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) throw Error('GRAPH');
  const data=await response.json();
  if(!data || typeof data !== 'object' || data.error)throw Error('GRAPH');
  return data;
}
async function proof(token, secret) {
  const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return hex(await crypto.subtle.sign('HMAC',key,encoder.encode(token)));
}
const validToken = value => typeof value === 'string' && value.length >= 8 && value.length <= 16384 && !/[\s\x00-\x1f]/.test(value);
function redirect(origin, status) {
  return new Response(null,{status:303,headers:{Location:`${origin}/?facebook=${status}#accounts`,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
}

// Caller must verify Access JWT + user scope. All ownership derives from that verified subject.
export async function facebook(request, env, owner, json) {
  const url=new URL(request.url),path=url.pathname.slice('/channels/facebook'.length);
  if (path && path !== '/start' && path !== '/callback' && !/^\/\d{1,32}\/disconnect$/.test(path)) return json({error:'Không tìm thấy kết nối.'},404);
  const method = path === '/start' || path.endsWith('/disconnect') ? 'POST' : 'GET';
  if(request.method!==method)return json({error:`Chỉ hỗ trợ ${method}.`},405,{Allow:method});
  if(method==='POST' && request.headers.get('Origin')!==url.origin)return json({error:'Chỉ cho phép thao tác từ cùng origin.'},403);
  const ready=configured(env,url.origin);
  if(!ready)return path ? json({error:'Kết nối Facebook chưa được cấu hình và cấp quyền đầy đủ.'},503) : json({configured:false,channels:[],permissions:SCOPES,publishing:false,inbox:false,scheduling:false});
  try {
    const limit=await env.AI_RATE_LIMITER?.limit({key:'facebook:'+owner});
    if(!limit || typeof limit.success!=='boolean')throw Error('RATE');
    if(!limit.success)return json({error:'Quá nhiều yêu cầu kết nối. Thử lại sau.'},429,{'Retry-After':'60'});
    if(!path) {
      const {results}=await env.DB.prepare('SELECT page_id, name, scopes, tasks, verified_at, status FROM facebook_connections WHERE owner = ? ORDER BY name, page_id').bind(owner).all();
      return json({configured:true,permissions:SCOPES,publishing:false,inbox:false,scheduling:false,channels:results.map(r=>({pageId:r.page_id,name:r.name,status:r.status,scopes:JSON.parse(r.scopes),tasks:JSON.parse(r.tasks),verifiedAt:r.verified_at}))});
    }
    if(path.endsWith('/disconnect')) {
      const id=path.split('/')[1];
      const result=await env.DB.prepare("UPDATE facebook_connections SET token_cipher = NULL, status = 'disconnected' WHERE owner = ? AND page_id = ?").bind(owner,id).run();
      return result.meta.changes ? json({disconnected:true}) : json({error:'Không tìm thấy kết nối.'},404);
    }
    const callback=`${env.APP_ORIGIN}/channels/facebook/callback`;
    if(path==='/start') {
      const state=base64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
      await env.DB.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(Date.now()).run();
      await env.DB.prepare('INSERT INTO oauth_states (state_hash, owner, origin, expires_at) VALUES (?, ?, ?, ?)').bind(await hash(state),owner,env.APP_ORIGIN,Date.now()+600000).run();
      const target=new URL(`https://www.facebook.com/${VERSION}/dialog/oauth`);
      target.searchParams.set('client_id',env.FACEBOOK_APP_ID);
      target.searchParams.set('redirect_uri',callback);
      target.searchParams.set('state',state);
      target.searchParams.set('response_type','code');
      if(env.FACEBOOK_CONFIG_ID)target.searchParams.set('config_id',env.FACEBOOK_CONFIG_ID);
      else target.searchParams.set('scope',SCOPES.join(','));
      return json({url:target.href});
    }
    const state=url.searchParams.get('state');
    if(!state || !/^[A-Za-z0-9_-]{43}$/.test(state))return json({error:'Phiên kết nối không hợp lệ. Bắt đầu lại từ Kênh.'},400);
    // Atomic consumption also prevents two concurrent callbacks from exchanging the same code.
    const stored=await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ? AND owner = ? AND origin = ? AND expires_at >= ? RETURNING owner').bind(await hash(state),owner,env.APP_ORIGIN,Date.now()).first();
    if(!stored)return json({error:'Phiên kết nối hết hạn hoặc đã sử dụng. Bắt đầu lại từ Kênh.'},400);
    if(url.searchParams.has('error'))return redirect(env.APP_ORIGIN,'cancelled');
    const code=url.searchParams.get('code');
    if(!code || code.length>4096 || /[\x00-\x20]/.test(code))return json({error:'Mã xác thực không hợp lệ.'},400);
    let pages,scopes;
    try {
      const token=await graph('oauth/access_token',null,{client_id:env.FACEBOOK_APP_ID,client_secret:env.FACEBOOK_APP_SECRET,redirect_uri:callback,code});
      if(!validToken(token.access_token))throw Error('TOKEN');
      const debug=await graph('debug_token',`${env.FACEBOOK_APP_ID}|${env.FACEBOOK_APP_SECRET}`,{input_token:token.access_token});
      const info=debug.data,now=Math.floor(Date.now()/1000);
      if(!info || info.is_valid!==true || String(info.app_id)!==env.FACEBOOK_APP_ID || !/^\d{1,32}$/.test(info.user_id || '') || !Number.isFinite(info.expires_at) || (info.expires_at!==0 && info.expires_at<=now) || (info.data_access_expires_at!==undefined && (!Number.isFinite(info.data_access_expires_at) || (info.data_access_expires_at!==0 && info.data_access_expires_at<=now))))throw Error('TOKEN');
      const appsecret_proof=await proof(token.access_token,env.FACEBOOK_APP_SECRET);
      const permissions=await graph('me/permissions',token.access_token,{appsecret_proof});
      if(!Array.isArray(permissions.data))throw Error('PERMISSIONS');
      scopes=SCOPES.filter(scope=>permissions.data.some(p=>p.permission===scope && p.status==='granted'));
      if(!scopes.includes('pages_show_list'))throw Error('PERMISSIONS');
      pages=[];let after;const seen=new Set();
      for(let n=0;n<10;n++) {
        const data=await graph('me/accounts',token.access_token,{fields:'id,name,access_token,tasks',limit:100,appsecret_proof,...(after?{after}:{})});
        if(!Array.isArray(data.data))throw Error('PAGES');
        for(const page of data.data) {
          if(!/^\d{1,32}$/.test(page.id || '') || typeof page.name!=='string' || page.name.length>512 || !validToken(page.access_token) || !Array.isArray(page.tasks) || page.tasks.some(t=>typeof t!=='string' || t.length>64) || seen.has(page.id))throw Error('PAGE');
          seen.add(page.id);pages.push(page);
        }
        if(!data.paging?.next)break;
        after=data.paging?.cursors?.after;
        if(typeof after!=='string' || !after || after.length>2048 || n===9)throw Error('PAGINATION');
      }
    } catch { return json({error:'Meta chưa xác nhận được tài khoản, quyền hoặc danh sách Trang. Kết nối cũ được giữ nguyên; hãy thử lại.'},502); }
    const statements=[env.DB.prepare("UPDATE facebook_connections SET token_cipher = NULL, status = 'disconnected' WHERE owner = ?").bind(owner)];
    for(const page of pages)statements.push(env.DB.prepare("INSERT INTO facebook_connections (owner,page_id,name,token_cipher,scopes,tasks,verified_at,status) VALUES (?,?,?,?,?,?,?,'connected') ON CONFLICT(owner,page_id) DO UPDATE SET name=excluded.name, token_cipher=excluded.token_cipher, scopes=excluded.scopes, tasks=excluded.tasks, verified_at=excluded.verified_at,status='connected'").bind(owner,page.id,page.name,await sealToken(page.access_token,env.CHANNEL_TOKEN_KEY,owner,page.id),JSON.stringify(scopes),JSON.stringify(page.tasks),Date.now()));
    await env.DB.batch(statements);
    return redirect(env.APP_ORIGIN,pages.length?'connected':'empty');
  } catch { return json({error:'Không thể truy cập cấu hình kết nối. Chưa xác nhận kết nối thành công.'},503); }
}
