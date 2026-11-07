import frontend from '../../index.html';
import api from './worker.js';

// Điểm vào Wrangler: HTML đóng gói dạng Text; không thay đổi binding gốc.
export default {
  fetch(request, env, ctx) {
    return api.fetch(request, { ...env, FRONTEND_HTML: frontend }, ctx);
  }
};
