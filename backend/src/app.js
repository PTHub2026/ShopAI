import frontend from '../../index.html';
import api from './worker.js';
const RELEASE_SHA = null;

export default {
  fetch(request, env, ctx) {
    return api.fetch(request, { ...env, FRONTEND_HTML: frontend, RELEASE_SHA }, ctx);
  }
};

