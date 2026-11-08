import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const appSource = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const htmlFixture = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
const loginFixture = await readFile(new URL('../../login.html', import.meta.url), 'utf8');
const workerSource = `export default { fetch(request, env) { return new Response(new URL(request.url).pathname === '/login-fixture' ? env.LOGIN_HTML : env.FRONTEND_HTML); } };`;
const workerURL = 'data:text/javascript;base64,' + Buffer.from(workerSource).toString('base64');
const appModule = appSource
  .replace("import frontend from '../../index.html';", 'const frontend = ' + JSON.stringify(htmlFixture) + ';')
  .replace("import loginPage from '../../login.html';", () => 'const loginPage = ' + JSON.stringify(loginFixture) + ';')
  .replace("'./worker.js'", JSON.stringify(workerURL));
const app = (await import('data:text/javascript;base64,' + Buffer.from(appModule).toString('base64'))).default;

test('Worker app passes the repository frontend to the API handler', async () => {
  const response = await app.fetch(new Request('https://shopai-backend.example/'), {});
  assert.equal(await response.text(), htmlFixture);
});
test('Worker app passes the repository login page to the API handler', async () => {
  const response = await app.fetch(new Request('https://shopai-backend.example/login-fixture'), {});
  assert.equal(await response.text(), loginFixture);
});
