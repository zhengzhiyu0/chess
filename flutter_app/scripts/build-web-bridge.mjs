import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const original = resolve(app, '../web');
const viteEntry = resolve(original, 'node_modules/vite/dist/node/index.js');
if (!existsSync(viteEntry)) throw new Error('缺少 web/node_modules/vite；请先在原 web 项目安装依赖');
const { build } = await import(pathToFileURL(viteEntry).href);
const lifecycle = resolve(app, 'bridge/lifecycle.ts').replaceAll('\\', '/');

function replaceRequired(code, before, after, name) {
  if (!code.includes(before)) throw new Error(`原引擎 ${name} 接口已变更，请重新检查 Flutter 适配`);
  return code.replace(before, after);
}

// Compile-time adaptations only: original web/src stays untouched. Force the
// browser transport so importing native.ts never starts Capacitor polling, and
// place readiness barriers before a search without copying the engine classes.
const browserEngine = {
  name: 'flutter-browser-engines',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source === '../native' && importer?.replaceAll('\\', '/').startsWith(original.replaceAll('\\', '/') + '/src/')) return '\0flutter-browser-native';
  },
  load(id) {
    if (id === '\0flutter-browser-native') return 'export const isNative = false; export const thermalState = 0;';
  },
  transform(code, id) {
    code = code.replaceAll('\r\n', '\n');
    const file = id.replaceAll('\\', '/').split('?')[0];
    if (file === original.replaceAll('\\', '/') + '/src/maia/maia.ts') {
      code = `import { trackEngineStart, finishEngineStart } from ${JSON.stringify(lifecycle)};\n` + code;
      code = replaceRequired(code, 'const m = new Maia(model, backend);', 'const m = new Maia(model, backend); trackEngineStart(m);', 'Maia.create');
      code = replaceRequired(code, '        lean,\n      });', '        lean,\n      }, 115000);', 'Maia.load timeout');
      code = replaceRequired(code, "      m.dispose();\n      throw err;\n    }\n    return m;", "      m.dispose();\n      throw err;\n    } finally { finishEngineStart(m); }\n    return m;", 'Maia.create cleanup');
      code = replaceRequired(code, '  private nextId = 1;', '  private nextId = 1;\n  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();', 'Maia timers');
      code = replaceRequired(code, '      this.pending.delete(msg.reqId);', '      clearTimeout(this.timers.get(msg.reqId));\n      this.timers.delete(msg.reqId);\n      this.pending.delete(msg.reqId);', 'Maia reply timeout cleanup');
      code = replaceRequired(code, '    this.pending.clear();', '    this.pending.clear();\n    for (const timer of this.timers.values()) clearTimeout(timer);\n    this.timers.clear();', 'Maia cancellation timeout cleanup');
      const start = code.indexOf('  private watch(reqId: number, timeout: number) {');
      const end = code.indexOf('  /** In the iOS app', start);
      if (start < 0 || end < 0) throw new Error('原 Maia.watch 接口已变更');
      code = code.slice(0, start) + `  private watch(reqId: number, timeout: number) {
    clearTimeout(this.timers.get(reqId));
    this.timers.set(reqId, setTimeout(() => { if (this.pending.has(reqId)) this.fail('Maia 无响应', true); }, timeout));
  }\n\n` + code.slice(end);
      return code;
    }
    if (file !== original.replaceAll('\\', '/') + '/src/engine/stockfish.ts') return;
    code = `import { trackEngineStart, finishEngineStart } from ${JSON.stringify(lifecycle)};\n` + code;
    code = replaceRequired(code, '    const requested = performance.now();\n    const context =', '    const loading = { dispose: () => this.terminate() };\n    trackEngineStart(loading, "stockfish");\n    const requested = performance.now();\n    const context =', 'Stockfish.handshake');
    code = replaceRequired(code, "    let stage = 'uci_startup';", "    let startupTimer: ReturnType<typeof setTimeout> | undefined;\n    let stage = 'uci_startup';", 'Stockfish startup timer');
    code = replaceRequired(code, '      this.failed = null;\n    }\n    return this;', '      this.failed = null;\n      clearTimeout(startupTimer);\n      finishEngineStart(loading);\n    }\n    return this;', 'Stockfish.handshake cleanup');
    const timerStart = code.indexOf('        let left = timeoutMs;');
    const timerEnd = code.indexOf('        // The first uciok', timerStart);
    if (timerStart < 0 || timerEnd < 0) throw new Error('原 Stockfish startup timer 接口已变更');
    code = code.slice(0, timerStart) + "        startupTimer = setTimeout(() => reject(new Error('Stockfish 启动超时')), timeoutMs);\n" + code.slice(timerEnd);
    code = replaceRequired(code, 'setTimeout(() => (document.hidden ? arm(ms, fn) : fn()), ms)', 'setTimeout(fn, ms)', 'Stockfish search timeout');
    const before = 'const p = this.queue.then(run, run);';
    return replaceRequired(code, before, `const prepare = async () => {
      if (opts.signal?.aborted || this.dead) return { lines: [], bestmove: null };
      this.send('stop');
      await this.waitFor('isready', (l) => l === 'readyok');
      if (opts.signal?.aborted || this.dead) return { lines: [], bestmove: null };
      return run();
    };
    const p = this.queue.then(prepare, prepare);`, 'Stockfish search queue');
  },
};

await build({
  configFile: false,
  root: resolve(app, 'bridge'),
  publicDir: false,
  base: './',
  plugins: [browserEngine],
  resolve: { preserveSymlinks: true },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: {
    target: 'es2022',
    outDir: resolve(app, 'web/engine'),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: resolve(app, 'bridge/index.ts'),
      output: { format: 'es', entryFileNames: 'bridge.js', chunkFileNames: 'chunks/[name]-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' },
    },
  },
});
console.log('Flutter engine bridge ready: web/engine/bridge.js (load as an ES module before Flutter bootstrap)');
