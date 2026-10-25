/**
 * scripts/live-check.mjs — verify a *deployed* build really renders.
 *
 * Loads a deployed URL in headless Chromium (real WebGL2), waits for the app to
 * boot, then asserts on frames, fps and pixels read back out of the GPU, plus
 * asset/network/console health. Same measurement code as the local render check.
 *
 *   node scripts/live-check.mjs https://<user>.github.io/<repo>/
 *   npm run check:live          # uses the URL from package.json "homepage" or GH_OWNER/REPO_NAME
 */

import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BROWSER_ARGS, findBrowser } from './browser.mjs';
import { pageStats } from './render-check.mjs';

function defaultUrl() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'));
    if (pkg.homepage && /^https?:/.test(pkg.homepage)) return pkg.homepage;
    const owner = process.env.GH_OWNER || 'whobutsb';
    const repo = process.env.REPO_NAME || 'event-horizon';
    return `https://${owner}.github.io/${repo}/`;
  } catch {
    return 'https://whobutsb.github.io/event-horizon/';
  }
}

const url = process.argv[2] || defaultUrl();
const exe = findBrowser();
if (!exe) {
  console.error('no Chromium-family browser found (set EH_BROWSER=/path/to/browser)');
  process.exit(1);
}

const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: [...BROWSER_ARGS] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

const errors = [];
const badResponses = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
});
page.on('response', (r) => {
  if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`);
});
page.on('requestfailed', (r) => badResponses.push(`FAILED ${r.url()}`));

const t0 = Date.now();
await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
await page.waitForFunction('window.EH && window.EH.sim.stats.frameMs > 0', { timeout: 90000 });
const bootSec = (Date.now() - t0) / 1000;

// let the governor settle and several hundred frames elapse
await new Promise((r) => setTimeout(r, 6000));

const info = await page.evaluate(() => {
  const s = window.EH.sim;
  const dbg = s.renderer.getContext().getExtension('WEBGL_debug_renderer_info');
  return {
    programs: s.renderer.info.programs.length,
    fps: Math.round(s.stats.fps),
    tier: s.stats.tier,
    steps: s.stats.steps,
    renderScale: Number(s.pixelScale.toFixed(2)),
    title: document.title,
    gl: s.renderer.getContext().getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : s.renderer.getContext().RENDERER),
  };
});
const stats = await page.evaluate(pageStats, {});

// exercise the UI over the network too: preset buttons + probe drop
const interaction = await page.evaluate(async () => {
  const click = (re) => {
    const b = [...document.querySelectorAll('button')].find((x) => re.test(x.textContent));
    if (b) b.click();
    return Boolean(b);
  };
  const sgra = click(/Sagittarius/i);
  await new Promise((r) => setTimeout(r, 1200));
  const probe = click(/DROP PROBE|PROBE/i);
  await new Promise((r) => setTimeout(r, 2500));
  const ro = window.EH.probe.readout();
  return { sgra, probe, probeR: ro.r, probeR0: ro.r0, probeG: +ro.g.toFixed(3) };
});

await browser.close();

const report = { url, bootSec: +bootSec.toFixed(1), info, stats, interaction, errors, badResponses };
console.log(JSON.stringify(report, null, 2));

const fails = [];
if (errors.length) fails.push('console/page errors');
if (badResponses.length) fails.push('failed or 4xx requests');
if (info.programs < 4) fails.push('shader programs missing');
if (info.fps < 30) fails.push(`fps too low (${info.fps})`);
if (stats.max < 0.6) fails.push('frame has no bright pixels — nothing rendered?');
if (stats.centre > 0.06) fails.push('shadow centre is not black');
if (!interaction.sgra || !interaction.probe) fails.push('UI buttons missing');
if (!(interaction.probeR < interaction.probeR0)) {
  fails.push(`probe did not fall (r ${interaction.probeR} vs release ${interaction.probeR0})`);
}

if (fails.length) {
  console.error('\nFAILED: ' + fails.join(' · '));
  process.exitCode = 1;
} else {
  console.log(`\nOK: ${url} renders at ${info.fps} fps (${info.tier}), shadow black, UI responsive.`);
}
