// Unified Chromium + WebKit regression for automatic Glicko-2 placement, settings and periods.
// Run Vite on 4175, or pass its URL as the first argument.
if (process.argv[2]) process.env.TEST_BASE_URL = process.argv[2];
await import('../scripts/rating-review-browser-check.mjs');
