/**
 * scripts/browser.mjs — locate a Chromium-family browser for puppeteer-core.
 * Kept separate so both the smoke test and `npm run verify` can use it.
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.EH_BROWSER,
  process.env.CHROME_PATH,
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];

/** Directories that hold a puppeteer-downloaded browser, searched recursively. */
const CACHE_DIRS = [join(homedir(), '.cache/puppeteer/chrome')];

/** Absolute path to a usable browser binary, or null. */
export function findBrowser() {
  for (const c of CANDIDATES) {
    if (!c) continue;
    if (existsSync(c)) return c;
  }
  // puppeteer's own download cache: .../chrome/<version>/<bundle>/<executable>
  for (const root of CACHE_DIRS) {
    if (!existsSync(root)) continue;
    try {
      for (const dir of readdirSync(root)) {
        for (const exe of [
          'chrome-linux64/chrome',
          'chrome-linux/chrome',
          'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
          'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        ]) {
          const p = join(root, dir, exe);
          if (existsSync(p)) return p;
        }
      }
    } catch {
      /* ignore unreadable cache */
    }
  }
  return null;
}

export const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--use-gl=angle',
  '--use-angle=metal',
  '--enable-unsafe-swiftshader',
  '--disable-features=TranslateUI',
  '--hide-scrollbars',
  '--mute-audio',
];
