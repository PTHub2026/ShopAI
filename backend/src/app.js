import frontend from '../../index.html';
import api from './worker.js';

export default {
  fetch(request, env, ctx) {
    return api.fetch(request, { ...env, FRONTEND_HTML: frontend }, ctx);
  }
};
