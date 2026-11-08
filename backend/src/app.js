import frontend from '../../index.html';
import loginPage from '../../login.html';
import api from './worker.js';
const RELEASE_SHA = null;

export default {
  fetch(request, env, ctx) {
    return api.fetch(request, { ...env, FRONTEND_HTML: frontend, LOGIN_HTML: loginPage, RELEASE_SHA }, ctx);
  }
};
