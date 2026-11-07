import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const appSource = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const htmlFixture = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
const workerSource = `export default { fetch(request, env) { return new Response(env.FRONTEND_HTML); } };`;
const workerURL = 'data:text/javascript;base64,' + Buffer.from(workerSource).toString('base64');
const appModule = appSource
  .replace("import frontend from '../../index.html';", 'const frontend = ' + JSON.stringify(htmlFixture) + ';')
  .replace("'./worker.js'", JSON.stringify(workerURL));
const app = (await import('data:text/javascript;base64,' + Buffer.from(appModule).toString('base64'))).default;

test('Worker app passes the repository frontend to the API handler', async () => {
  const response = await app.fetch(new Request('https://shopai-backend.example/'), {});
  assert.equal(await response.text(), htmlFixture);
});
