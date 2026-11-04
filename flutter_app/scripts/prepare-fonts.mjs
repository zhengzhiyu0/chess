// Offline Flutter fonts. Run from any directory:
//   node flutter_app/scripts/prepare-fonts.mjs          download/verify
//   node flutter_app/scripts/prepare-fonts.mjs --check  verify, no network/writes
// No npm dependencies. curl.exe (Windows) / curl handles system proxy/TLS.
// All upstream files are unmodified SIL OFL 1.1 fonts, not app runtime URLs.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(app, 'assets/fonts');
export const commit = 'a85815a42757630ce188fdad368c2dfc444d4773';
const repository = 'https://github.com/google/fonts';

// SHA-256s were checked against the exact blobs returned by GitHub's official
// API at the pinned commit, independently of the CDN. Never accept "latest".
export const files = [
  { name: 'NotoSansSC[wght].ttf', folder: 'notosanssc', family: 'NotoSansSC', bytes: 17772300,
    sha256: 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da',
    blob: 'fb0637bafbcd804fe32152370a1225990745b4bc', license: 'OFL-NotoSansSC.txt', weights: [100, 900] },
  { name: 'OFL-NotoSansSC.txt', upstream: 'OFL.txt', folder: 'notosanssc', bytes: 4388,
    sha256: '1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9',
    blob: '1c9f43281b8f216c5461fe9ac729afbade7724e4' },
  { name: 'NotoSansSymbols2-Regular.ttf', folder: 'notosanssymbols2', family: 'NotoSansSymbols2', bytes: 1233128,
    sha256: '7d5fb73b7ca67a6798101741f5d280a3d016a56a197afcd4199dbb57b4b82a21',
    blob: 'caf89dd0e60e23ac39ce18da823095959d409437', license: 'OFL-NotoSansSymbols2.txt' },
  { name: 'OFL-NotoSansSymbols2.txt', upstream: 'OFL.txt', folder: 'notosanssymbols2', bytes: 4383,
    sha256: 'b118dd41337806a5d4797052c77caf3bd096aed783e5eb21b4d11154351e1ac0',
    blob: '7c95767f5c669c448148e7e6c8fc4ee2c85128b1' },
  // Monochrome outline TTF works without color-font-specific rendering support.
  { name: 'NotoEmoji[wght].ttf', folder: 'notoemoji', family: 'NotoEmoji', bytes: 1982596,
    sha256: 'de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551',
    blob: 'c2c26ab612a88a8610ff9cfbb89299bf2aea6c7a', license: 'OFL-NotoEmoji.txt', weights: [300, 700] },
  { name: 'OFL-NotoEmoji.txt', upstream: 'OFL.txt', folder: 'notoemoji', bytes: 4330,
    sha256: '500bb1ccf43df7bbb522112f9133a52b16e1c35e809632f5d8609b179152de5b',
    blob: 'd09d3d0e09169f6747754e6b25faf5ba5ef6402d' },
];

function urls(file) {
  const path = `ofl/${file.folder}/${encodeURIComponent(file.upstream ?? file.name)}`;
  return [
    `https://fastly.jsdelivr.net/gh/google/fonts@${commit}/${path}`,
    `https://cdn.jsdelivr.net/gh/google/fonts@${commit}/${path}`,
    `https://gcore.jsdelivr.net/gh/google/fonts@${commit}/${path}`,
    `https://api.github.com/repos/google/fonts/git/blobs/${file.blob}`,
  ];
}

export function verifyFile(bytes, file) {
  if (bytes.length !== file.bytes) throw new Error(`${file.name}: size ${bytes.length}, expected ${file.bytes}`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== file.sha256) throw new Error(`${file.name}: SHA-256 mismatch: ${sha256}`);
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (blob !== file.blob) throw new Error(`${file.name}: upstream Git blob mismatch`);
  if (!file.family && !bytes.toString('utf8').includes('SIL OPEN FONT LICENSE Version 1.1')) {
    throw new Error(`${file.name}: missing SIL OFL 1.1 text`);
  }
}

function parseResponse(bytes) {
  let start = 0;
  let status;
  let headers;
  // --include may prepend proxy CONNECT, redirect or informational headers.
  while (bytes.toString('ascii', start, start + 5) === 'HTTP/') {
    const end = bytes.indexOf('\r\n\r\n', start);
    if (end < 0) throw new Error('Incomplete HTTP headers');
    const block = bytes.toString('utf8', start, end).split('\r\n');
    status = Number(block.shift().split(' ')[1]);
    headers = Object.fromEntries(block.map(line => {
      const colon = line.indexOf(':');
      return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
    }));
    start = end + 4;
  }
  if (!status) throw new Error('Missing HTTP response');
  return { status, headers, body: bytes.subarray(start) };
}

async function downloadPart(file, start, end) {
  const errors = [];
  for (const base of urls(file)) {
    // A cache key per range also protects against intermediaries that cache
    // partial responses without including the Range header in their key.
    const url = `${base}?range=${start}-${end}`;
    const args = ['--fail', '--location', '--silent', '--show-error', '--include',
      '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '8',
      '--max-time', '30', '--range', `${start}-${end}`,
      '-H', 'Accept: application/vnd.github.raw+json', url];
    try {
      const { stdout } = await run(curl, args, { encoding: 'buffer', maxBuffer: file.bytes + 65536, windowsHide: true, timeout: 35000 });
      const response = parseResponse(stdout);
      if (response.status === 200 && response.body.length === file.bytes) {
        verifyFile(response.body, file);
        return response.body.subarray(start, end + 1);
      }
      if (response.status !== 206 || response.headers['content-range'] !== `bytes ${start}-${end}/${file.bytes}` || response.body.length !== end - start + 1) {
        throw new Error(`Unexpected range: ${response.status}, ${response.headers['content-range']}, ${response.body.length} bytes`);
      }
      return response.body;
    } catch (error) {
      errors.push(`${new URL(base).host}: ${error.stderr?.toString().trim() || error.message}`);
    }
  }
  throw new Error(`${file.name} bytes ${start}-${end}: ${errors.join('; ')}`);
}

async function download(file) {
  const chunk = 256 * 1024;
  const count = Math.ceil(file.bytes / chunk);
  const parts = new Array(count);
  let next = 0;
  let completed = 0;
  console.log(`Downloading ${file.name} (${file.bytes} bytes, pinned ${commit.slice(0, 12)})`);
  // Bounded parallel ranges avoid restarting a 17MB transfer on slow mirrors.
  const jobs = await Promise.allSettled(Array.from({ length: Math.min(8, count) }, async () => {
    while (next < count) {
      const i = next++;
      parts[i] = await downloadPart(file, i * chunk, Math.min(file.bytes - 1, (i + 1) * chunk - 1));
      completed++;
      if (count > 8 && (completed % 16 === 0 || completed === count)) console.log(`  ${file.name}: ${completed}/${count}`);
    }
  }));
  const failed = jobs.find(job => job.status === 'rejected');
  if (failed) throw failed.reason;
  const bytes = Buffer.concat(parts);
  verifyFile(bytes, file);
  return bytes;
}

// Read sfnt/cmap directly: no Python/font-tool dependency or browser required.
export function inspectFont(bytes) {
  if (bytes.readUInt32BE(0) !== 0x00010000) throw new Error('Expected a TrueType sfnt file');
  const tables = {};
  const tableCount = bytes.readUInt16BE(4);
  for (let i = 0; i < tableCount; i++) {
    const p = 12 + i * 16;
    const tag = bytes.toString('ascii', p, p + 4);
    const offset = bytes.readUInt32BE(p + 8);
    const length = bytes.readUInt32BE(p + 12);
    if (offset + length > bytes.length) throw new Error(`Invalid font table: ${tag}`);
    tables[tag] = { offset, length };
  }
  for (const tag of ['cmap', 'head', 'maxp', 'name', 'glyf']) {
    if (!tables[tag]) throw new Error(`Missing font table: ${tag}`);
  }
  const axes = [];
  if (tables.fvar) {
    const f = tables.fvar.offset;
    const firstAxis = f + bytes.readUInt16BE(f + 4);
    const stride = bytes.readUInt16BE(f + 10);
    for (let i = 0; i < bytes.readUInt16BE(f + 8); i++) {
      const p = firstAxis + i * stride;
      axes.push({ tag: bytes.toString('ascii', p, p + 4), min: bytes.readInt32BE(p + 4) / 65536, default: bytes.readInt32BE(p + 8) / 65536, max: bytes.readInt32BE(p + 12) / 65536 });
    }
  }
  const cmaps = [];
  const cmap = tables.cmap.offset;
  for (let i = 0; i < bytes.readUInt16BE(cmap + 2); i++) {
    const record = cmap + 4 + i * 8;
    const platform = bytes.readUInt16BE(record);
    const encoding = bytes.readUInt16BE(record + 2);
    if (platform !== 0 && !(platform === 3 && (encoding === 1 || encoding === 10))) continue;
    const offset = cmap + bytes.readUInt32BE(record + 4);
    const format = bytes.readUInt16BE(offset);
    if (format === 4 || format === 12) cmaps.push({ offset, format });
  }
  const hasGlyph = cp => cmaps.some(({ offset: p, format }) => {
    if (format === 12) {
      let left = 0;
      let right = bytes.readUInt32BE(p + 12) - 1;
      while (left <= right) {
        const middle = (left + right) >>> 1;
        const group = p + 16 + middle * 12;
        const from = bytes.readUInt32BE(group);
        const to = bytes.readUInt32BE(group + 4);
        if (cp < from) right = middle - 1;
        else if (cp > to) left = middle + 1;
        else return bytes.readUInt32BE(group + 8) + cp - from !== 0;
      }
      return false;
    }
    if (cp > 0xffff) return false;
    const segments = bytes.readUInt16BE(p + 6) / 2;
    const ends = p + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const ranges = deltas + segments * 2;
    for (let i = 0; i < segments; i++) {
      if (cp > bytes.readUInt16BE(ends + i * 2)) continue;
      if (cp < bytes.readUInt16BE(starts + i * 2)) return false;
      const delta = bytes.readInt16BE(deltas + i * 2);
      const range = bytes.readUInt16BE(ranges + i * 2);
      if (!range) return ((cp + delta) & 0xffff) !== 0;
      const glyph = bytes.readUInt16BE(ranges + i * 2 + range + (cp - bytes.readUInt16BE(starts + i * 2)) * 2);
      return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0;
    }
    return false;
  });
  return { glyphCount: bytes.readUInt16BE(tables.maxp.offset + 4), axes, hasGlyph };
}

async function install(file, check) {
  const path = resolve(destination, file.name);
  let bytes;
  try { bytes = await readFile(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (bytes) {
    // Never silently overwrite a changed/corrupt local font or license.
    verifyFile(bytes, file);
    console.log(`Verified ${file.name} (SHA-256 ${file.sha256})`);
  } else {
    if (check) throw new Error(`Missing ${path}; run without --check first`);
    bytes = await download(file);
    const temporary = `${path}.${randomUUID()}.part`;
    try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
    console.log(`Installed ${file.name} (SHA-256 ${file.sha256})`);
  }
  return file.family ? { file, ...inspectFont(bytes) } : null;
}

// Importers call await main() without inheriting their own CLI flags (--web).
export async function main(args = []) {
  if (args.includes('--help')) {
    console.log('node flutter_app/scripts/prepare-fonts.mjs [--check]\nDownloads pinned Noto Sans SC, Symbols 2, monochrome Noto Emoji and their OFL 1.1 licenses.\n--check: verify existing files without network access or writes.');
    return;
  }
  if (args.some(arg => arg !== '--check')) throw new Error(`Unknown argument: ${args.join(' ')}`);
  const check = args.includes('--check');
  if (!check) await mkdir(destination, { recursive: true });
  const fonts = [];
  for (const file of files) {
    const font = await install(file, check);
    if (font) {
      if (file.weights && !font.axes.some(axis => axis.tag === 'wght' && axis.min === file.weights[0] && axis.max === file.weights[1])) {
        throw new Error(`${file.name}: incorrect variable weight axis`);
      }
      fonts.push(font);
    }
  }
  const samples = {
    chinese: '国际象棋离线教练开始对局复盘我的头像胜负和棋',
    chess: '♔♕♖♗♘♙♚♛♜♝♞♟',
    avatars: '🦁🐯🦊🐼🐨🐸🐧🦉🐱🐶🐰😎',
    notation: '±∓−×→←↑↓↗↘↔↕⇄○●∞…✓✗★☆⚠⚡🏆🧠🤖',
  };
  const coverage = Object.fromEntries(Object.entries(samples).map(([group, text]) => [group,
    Object.fromEntries([...new Set(text)].map(char => [char, fonts.filter(font => font.hasGlyph(char.codePointAt(0))).map(font => font.file.family)])),
  ]));
  for (const [group, text] of Object.entries(samples)) {
    const missing = [...new Set(text)].filter(char => !fonts.some(font => font.hasGlyph(char.codePointAt(0))));
    if (missing.length) throw new Error(`${group}: no bundled glyph for ${missing.join(' ')}`);
  }
  const manifest = {
    repository, commit, license: 'SIL Open Font License 1.1',
    note: 'Unmodified upstream font binaries. Distribute all three OFL notices with the app. NotoEmoji is monochrome. No runtime font network request is needed for the covered characters.',
    flutter: { fontFamily: 'NotoSansSC', fontFamilyFallback: ['NotoSansSymbols2', 'NotoEmoji'],
      assets: fonts.map(font => ({ family: font.file.family, asset: `assets/fonts/${font.file.name}`, license: font.file.license })) },
    files: files.map(file => ({ ...file, source: `${repository}/blob/${commit}/ofl/${file.folder}/${encodeURIComponent(file.upstream ?? file.name)}`, mirrors: urls(file) })),
    fonts: fonts.map(({ file, glyphCount, axes }) => ({ file: file.name, glyphCount, axes })), coverage,
  };
  if (!check) await writeFile(resolve(destination, 'SOURCES.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  for (const font of fonts) console.log(`${font.file.family}: ${font.glyphCount} glyphs; ${JSON.stringify(font.axes)}`);
  console.log(`Offline fonts verified: ${destination}\nFlutter: fontFamily NotoSansSC; fallback [NotoSansSymbols2, NotoEmoji].\nOFL 1.1: keep all three copyright/license notices with redistributed font binaries.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
