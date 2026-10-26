// Run against the dev server: node test/sound-assets.browser.mjs http://127.0.0.1:5173
import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright';

const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext(mobile ? devices['iPhone 13'] : {});
    // Exercise the real audio module and MP3s without loading chess engines.
    await context.route('**/sound-smoke', route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><button id="preview">试听</button>',
    }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.goto(`${process.argv[2] ?? 'http://127.0.0.1:5173'}/sound-smoke`);
    const themes = await page.evaluate(async () => {
      const sounds = await import('/src/audio/sound.ts');
      const starts = [];
      const originalStart = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...args) {
        if (this.buffer?.length > 1) {
          const data = this.buffer.getChannelData(0);
          starts.push({ duration: this.buffer.duration, peak: data.reduce((max, x) => Math.max(max, Math.abs(x)), 0) });
        }
        return originalStart.apply(this, args);
      };
      AudioContext.prototype.createOscillator = () => { throw new Error('Runtime synthesis is not allowed'); };
      window.soundSmoke = { sounds, starts, selected: 'board' };
      document.querySelector('#preview').onclick = () => sounds.previewTheme(window.soundSmoke.selected);
      return Object.keys(sounds.SOUND_THEMES);
    });
    for (const theme of themes) {
      await page.evaluate(theme => {
        window.soundSmoke.starts.length = 0;
        window.soundSmoke.selected = theme;
        window.soundSmoke.sounds.configureSound(false, false, theme);
      }, theme);
      await page.locator('#preview').click();
      await page.waitForFunction(() => window.soundSmoke.starts.length === 2);
      const clips = await page.evaluate(() => window.soundSmoke.starts);
      assert.ok(clips.every(clip => clip.duration > 0.02 && clip.duration < 10 && clip.peak > 0.001 && clip.peak <= 1), `${theme}: decoded clips must be audible and unclipped`);
    }
    assert.deepEqual(errors, []);
    console.log(`PASS: ${mobile ? 'iPhone viewport' : 'desktop'} — ${themes.length} MP3 themes decode and preview without synthesis`);
    await context.close();
  }
} finally {
  await browser.close();
}
