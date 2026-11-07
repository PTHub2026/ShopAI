import api from './worker.js';

const SOURCE = 'https://raw.githubusercontent.com/PTHub2026/ShopAI/bc680c3e3621b71bb02768b2f623ce8276db6124/index.html';
const OLD_CALL = `async call(task,p){const ep=S.settings.aiEndpoint;if(ep){try{const r=await fetch(ep,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({task,brand:S.settings.brand,profile:{description:S.settings.desc,audience:S.settings.audience,features:S.settings.features,rules:S.settings.rules},...p})});if(r.ok){const j=await r.json();if(j&&j.text)return j.text}throw new Error('HTTP '+r.status)}catch(e){toast('Endpoint AI lỗi – chuyển sang engine nội bộ')}}await new Promise(r=>setTimeout(r,200));return AI.local[task](p)}`;
const NEW_CALL = `async call(task,p){if(window.QA_RUNNING){const e=new Error('Bỏ qua kiểm thử cần AI thật');e.skip='Không gọi AI thật trong chế độ QA';throw e}try{const r=await fetch('/ai',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({task,brand:S.settings.brand,profile:{description:S.settings.desc,audience:S.settings.audience,features:S.settings.features,rules:S.settings.rules},...p}),signal:AbortSignal.timeout(90000)});const j=await r.json();if(!r.ok)throw new Error(j.error||('HTTP '+r.status));if(!j||typeof j.text!=='string'||!j.text.trim())throw new Error('AI chưa trả về nội dung hợp lệ');return j.text}catch(e){toast('AI thật chưa xử lý được. Không dùng nội dung mô phỏng.');throw e}}`;
const OLD_TEST = `async function testAI(){const ep=$('#st_ai').value.trim();if(!ep)return toast('Chưa nhập endpoint');try{const r=await fetch(ep,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({task:'reply',text:'Xin chào',name:'Test'})});const j=await r.json();toast(j&&j.text?'Kết nối OK: '+String(j.text).slice(0,60):'Phản hồi không có trường "text"')}catch(e){toast('Không kết nối được: '+e.message)}}`;
const NEW_TEST = `async function testAI(){try{const text=await AI.call('reply',{text:'Xin chào',name:'Kiểm tra kết nối'});toast('AI thật trả lời: '+text.slice(0,80))}catch(e){toast('Chưa kết nối được AI thật. Hãy đăng nhập lại hoặc thử sau.')}}`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/ai' || url.pathname === '/health' || request.method === 'OPTIONS') return api.fetch(request, env, ctx);
    if (url.pathname !== '/' && url.pathname !== '/index.html') return new Response('Không tìm thấy trang.', { status: 404 });
    if (request.method !== 'GET') return new Response('Chỉ hỗ trợ GET.', { status: 405, headers: { Allow: 'GET' } });
    try {
      const upstream = await fetch(SOURCE, { cf: { cacheTtl: 3600 }, signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!upstream.ok) throw new Error('SOURCE_UNAVAILABLE');
      let html = await upstream.text();
      if (!html.includes(OLD_CALL) || !html.includes(OLD_TEST)) throw new Error('SOURCE_CONTRACT_CHANGED');
      html = html.replace(OLD_CALL, NEW_CALL).replace(OLD_TEST, NEW_TEST).replace("aiEndpoint:''", "aiEndpoint:'/ai'");
      const integration = `<script>\nS.settings.aiEndpoint='/ai';\nconst shopaiRender=render;render=function(r){S.settings.aiEndpoint='/ai';shopaiRender(r);const input=document.getElementById('st_ai');if(input){input.value='/ai';input.readOnly=true;}const title=document.getElementById('title');if(title){const status=document.createElement('span');status.textContent=' · AI qua backend thật · các kênh vẫn mô phỏng';status.style.cssText='font-size:11px;font-weight:400';title.appendChild(status);}};\nconst shopaiRunGen=runGen;runGen=async function(p){try{return await shopaiRunGen(p)}catch(e){if(e&&e.skip)throw e;const out=document.getElementById(p+'_out');if(out)out.innerHTML='<p class=\"muted\">Không thể tạo nội dung. Vui lòng thử lại.</p>';}};\nconst shopaiVCaption=vCaption;vCaption=async function(){try{return await shopaiVCaption()}catch(e){if(e&&e.skip)throw e;const button=document.getElementById('v_capbtn');if(button)button.textContent='✨ Viết caption';}};\naddEventListener('unhandledrejection',function(event){toast('Tác vụ chưa hoàn tất. Không tạo kết quả mô phỏng.');const button=document.getElementById('impBtn');if(button)button.textContent='🪄 Cải thiện bằng AI';});\nrender();\n</script>`;
      html = html.replace('</body>', integration + '</body>');
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; media-src 'self' https: data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" } });
    } catch { return new Response('Không tải được giao diện ShopAI. Vui lòng thử lại sau. Không chuyển sang dữ liệu AI mô phỏng.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }); }
  }
};
