import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const root = new URL('./', import.meta.url);
const html = await readFile(new URL('../index.html', root), 'utf8');
const frontendImport = "import frontend from '../../index.html';";
let app = await readFile(new URL('src/app.js', root), 'utf8');
if (!app.includes(frontendImport)) throw new Error('Không khớp điểm đóng gói giao diện; dừng build.');
app = app.replace(frontendImport, 'const frontend = ' + JSON.stringify(html) + ';');
let release = process.env.SHOPAI_RELEASE_SHA || process.env.GITHUB_SHA || process.env.CF_COMMIT_HASH;
if (!release) {
  try { release = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { throw new Error('Thiếu commit phát hành; đặt SHOPAI_RELEASE_SHA trước khi build.'); }
}
if (!/^[a-f0-9]{40}$/.test(release)) throw new Error('Commit phát hành không hợp lệ.');
if (!app.includes('const RELEASE_SHA = null;')) throw new Error('Không khớp điểm đóng gói commit; dừng build.');
app = app.replace('const RELEASE_SHA = null;', 'const RELEASE_SHA = ' + JSON.stringify(release) + ';');
await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL('dist/app.js', root), app);
await copyFile(new URL('src/worker.js', root), new URL('dist/worker.js', root));
await copyFile(new URL('src/drafts.js', root), new URL('dist/drafts.js', root));
console.log('Đã đóng gói giao diện từ repository cùng backend; không cần tải HTML bên ngoài lúc chạy.');

