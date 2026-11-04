import { createReadStream, existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let port = 5290;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]);
  else if (args[i].startsWith('--port=')) port = Number(args[i].slice(7));
  else throw new Error(`未知参数：${args[i]}`);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port 须为 1..65535');
const directory = resolve(app, 'build/web');
if (!existsSync(directory)) throw new Error('build/web 不存在，请先运行 flutter build web');
const root = await realpath(directory);
const withinRoot = path => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.bin': 'application/octet-stream',
};

const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  const reject = (code, message) => { response.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end(message); };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    reject(405, 'Method not allowed');
    return;
  }
  try {
    // Decode before resolving. Reject backslashes and ADS/drive syntax on
    // Windows as well as parent segments and symlinks leaving build/web.
    const pathname = decodeURIComponent((request.url ?? '/').split('?')[0]);
    if (pathname.includes('\0') || pathname.includes('\\') || pathname.includes(':') || pathname.split('/').includes('..')) {
      reject(403, 'Forbidden'); return;
    }
    let file = resolve(root, `.${pathname}`);
    if (!withinRoot(file)) { reject(403, 'Forbidden'); return; }
    let info = await stat(file);
    if (info.isDirectory()) { file = resolve(file, 'index.html'); info = await stat(file); }
    const actual = await realpath(file);
    if (!withinRoot(actual) || !info.isFile()) { reject(403, 'Forbidden'); return; }
    response.writeHead(200, { 'Content-Type': mime[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': info.size });
    if (request.method === 'HEAD') { response.end(); return; }
    createReadStream(actual).on('error', () => response.destroy()).pipe(response);
  } catch (error) {
    if (error instanceof URIError) reject(400, 'Bad URL');
    else if (error.code === 'ENOENT' || error.code === 'ENOTDIR') reject(404, 'Not found');
    else { console.error(error); reject(500, 'Server error'); }
  }
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Flutter preview: http://127.0.0.1:${port} (COOP/COEP enabled)\n${root}`));
