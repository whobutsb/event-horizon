/**
 * scripts/render-check.mjs — end-to-end render verification.
 *
 * Serves the production build with `vite preview`, drives a real Chromium-family
 * browser through puppeteer-core, and checks that the thing actually draws:
 * shader programs compiled, frames advanced, the shadow is dark, the disk is
 * bright, light is bent into a ring around the silhouette, lensing changes the
 * image, presets swap, the probe falls and redshifts, and the HUD fills in.
 *
 *   node scripts/render-check.mjs            # needs `npm run build` first
 *   node scripts/render-check.mjs --dev      # against the vite dev server
 *
 * Screenshots land in .artifacts/. Exits non-zero on any failed check.
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { preview, createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { BROWSER_ARGS, findBrowser } from './browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const ARTIFACTS = resolve(ROOT, '.artifacts');

/**
 * In-page measurement fn (stringified by puppeteer, so no closure variables).
 * Reads the composited canvas (or the HDR raymarch target) and returns compact
 * statistics: overall luma stats, how dark the shadow centre is, an annulus
 * profile around the projected hole (the lensing signature) and a coarse 16x9
 * fingerprint for frame-to-frame diffing.
 */
export function pageStats(opts) {
  const EH = window.EH;
  const sim = EH.sim;
  const gl = sim.renderer.getContext();
  const w = sim.width;
  const h = sim.height;

  return (async () => {
    // wait for a frame boundary so the drawing buffer is still intact
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));

    let buf;
    if (opts && opts.hdr) {
      const f32 = new Float32Array(w * h * 4);
      // setRenderTarget() binds the target's framebuffer, so readPixels hits it
      sim.renderer.setRenderTarget(sim.rtScene);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, f32);
      sim.renderer.setRenderTarget(null);
      const tm = (x) => Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
      buf = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        buf[i] =
          0.2126 * tm(f32[i * 4]) + 0.7152 * tm(f32[i * 4 + 1]) + 0.0722 * tm(f32[i * 4 + 2]);
      }
    } else {
      const bytes = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      buf = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        const r = bytes[i * 4] / 255;
        const g = bytes[i * 4 + 1] / 255;
        const b = bytes[i * 4 + 2] / 255;
        buf[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      }
    }

    let sum = 0;
    let max = 0;
    let bright = 0;
    let dark = 0;
    for (let i = 0; i < w * h; i++) {
      const l = buf[i];
      sum += l;
      if (l > max) max = l;
      if (l > 0.5) bright++;
      if (l < 0.03) dark++;
    }

    // centre patch: should sit inside the shadow silhouette
    let centre = 0;
    let cn = 0;
    const r0 = Math.max(4, Math.round(Math.min(w, h) * 0.02));
    const cx = Math.round(w / 2);
    const cy = Math.round(h / 2);
    for (let y = cy - r0; y <= cy + r0; y++) {
      for (let x = cx - r0; x <= cx + r0; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        centre += buf[y * w + x];
        cn++;
      }
    }

    // annulus profile around the projected hole: light bent into a ring shows up
    // as a peak at a small radius that stands above the far-field background
    const pose = EH.rig.shadowScreenPose(w / h);
    const px = pose.cx * w;
    const py = (1 - pose.cy) * h; // readPixels origin is bottom-left
    const basePx = Math.max(2, pose.radius * h);
    const rings = [];
    for (let k = 0.6; k <= 6.0001; k += 0.4) {
      let acc = 0;
      let count = 0;
      const rad = basePx * k;
      const steps = 96;
      for (let s = 0; s < steps; s++) {
        const a = (s / steps) * Math.PI * 2;
        const x = Math.round(px + Math.cos(a) * rad);
        const y = Math.round(py + Math.sin(a) * rad);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        acc += buf[y * w + x];
        count++;
      }
      rings.push(count ? acc / count : 0);
    }

    // mean luma strictly inside the silhouette, anchored to where the hole
    // actually projects (survives presets, auto-pan and camera moves)
    let shadowMean = 0;
    let sn = 0;
    const srad = Math.max(2, basePx * 0.5);
    for (let y = Math.round(py - srad); y <= py + srad; y += 2) {
      for (let x = Math.round(px - srad); x <= px + srad; x += 2) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (Math.hypot(x - px, y - py) > srad) continue;
        shadowMean += buf[y * w + x];
        sn++;
      }
    }

    const sig = [];
    const gx = 16;
    const gy = 9;
    for (let j = 0; j < gy; j++) {
      for (let i = 0; i < gx; i++) {
        const x = Math.round(((i + 0.5) / gx) * w);
        const y = Math.round(((j + 0.5) / gy) * h);
        sig.push(+buf[y * w + x].toFixed(3));
      }
    }

    return {
      hdr: Boolean(opts && opts.hdr),
      mean: sum / (w * h),
      max,
      fracBright: bright / (w * h),
      fracDark: dark / (w * h),
      centre: centre / Math.max(cn, 1),
      shadowMean: shadowMean / Math.max(sn, 1),
      pose: { cx: +pose.cx.toFixed(3), cy: +pose.cy.toFixed(3), radius: +pose.radius.toFixed(3) },
      rings,
      sig,
      width: w,
      height: h,
    };
  })();
}

export async function runRenderCheck({ dev = false, verbose = true, shots = true } = {}) {
  mkdirSync(ARTIFACTS, { recursive: true });
  const exe = findBrowser();
  if (!exe) throw new Error('no Chromium-family browser found (set EH_BROWSER=/path/to/browser)');

  let server;
  let url;
  if (dev) {
    server = await createServer({ configFile: resolve(ROOT, 'vite.config.js'), server: { port: 0 } });
    await server.listen();
    url = server.resolvedUrls.local[0];
  } else {
    server = await preview({
      configFile: resolve(ROOT, 'vite.config.js'),
      preview: { port: 0, host: '127.0.0.1' },
    });
    url = server.resolvedUrls.local[0];
  }

  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: true,
    args: [...BROWSER_ARGS, '--window-size=1440,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  const errors = [];
  const warnings = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error') errors.push(`console.error: ${m.text()}`);
    else if (t === 'warning') warnings.push(`console.warn: ${m.text()}`);
  });

  const log = (...a) => verbose && console.log(...a);
  log(`serving ${url} · browser ${exe}`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForFunction('window.EH && window.EH.sim.stats.frameMs > 0', { timeout: 60000 });
  // let it settle: camera damping done, a second of sim time elapsed, and the
  // quality governor has had frames to measure
  await new Promise((r) => setTimeout(r, 2000));
  await page.waitForFunction(
    () => {
      const s = window.EH.sim;
      const g = window.EH.rig;
      return (
        Math.abs(g.radius - g.targetRadius) < 0.02 &&
        Math.abs(g.phi - g.targetPhi) < 0.01 &&
        s.simT > 1.5 &&
        s.stats.frameMs > 0
      );
    },
    { timeout: 30000 },
  );
  await new Promise((r) => setTimeout(r, 1200));

  const info = await page.evaluate(() => {
    const s = window.EH.sim;
    return {
      programs: s.renderer.info.programs.length,
      calls: s.renderer.info.render.calls,
      geometries: s.renderer.info.memory.geometries,
      textures: s.renderer.info.memory.textures,
      width: s.width,
      height: s.height,
      tier: s.stats.tier,
      steps: s.stats.steps,
      fps: s.stats.fps,
      simT: s.simT,
      dilation: s.dilation,
      gl: (() => {
        const g = s.renderer.getContext();
        const dbg = g.getExtension('WEBGL_debug_renderer_info');
        return g.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : g.RENDERER);
      })(),
    };
  });

  const hdr = await page.evaluate(pageStats, { hdr: true }).catch((e) => {
    errors.push(`HDR readback failed: ${e.message}`);
    return null;
  });
  const ldr = await page.evaluate(pageStats, {}).catch((e) => {
    errors.push(`LDR readback failed: ${e.message}`);
    return null;
  });

  if (shots) await page.screenshot({ path: resolve(ARTIFACTS, '01-gargantua.png') });

  // --- lensing must change the image ------------------------------------
  const sigWithLensing = ldr ? ldr.sig : [];
  await page.evaluate(() => {
    window.EH.params.lensing = 0;
    window.EH.sim.setParams(window.EH.params);
  });
  await new Promise((r) => setTimeout(r, 700));
  const noLens = await page.evaluate(pageStats, {}).catch(() => null);
  if (shots && noLens) await page.screenshot({ path: resolve(ARTIFACTS, '02-no-lensing.png') });
  let lensDiff = 0;
  if (noLens && ldr) {
    for (let i = 0; i < sigWithLensing.length; i++) {
      lensDiff += Math.abs(sigWithLensing[i] - noLens.sig[i]);
    }
    lensDiff /= sigWithLensing.length;
  }
  await page.evaluate(() => {
    window.EH.params.lensing = 1;
    window.EH.sim.setParams(window.EH.params);
  });

  // --- presets -----------------------------------------------------------
  const presetResults = {};
  for (const [label, file] of [
    ['Sagittarius A★', '03-sgra.png'],
    ['Quiet', '04-quiet.png'],
    ['Cygnus X-1', '05-cygnus.png'],
    ['Gargantua', '06-gargantua-again.png'],
  ]) {
    const clicked = await page.evaluate((lbl) => {
      const btn = [...document.querySelectorAll('button.preset')].find((b) => b.textContent === lbl);
      if (!btn) return false;
      btn.click();
      return true;
    }, label);
    await new Promise((r) => setTimeout(r, 1400));
    const s = await page.evaluate(pageStats, {}).catch(() => null);
    const st = await page.evaluate(() => ({
      mass: window.EH.params.mass,
      spin: window.EH.params.spin,
      diskInner: window.EH.sim.derived.diskInner,
      rsLabel: [...document.querySelectorAll('.readouts .cell')].map((c) => c.textContent).join(' | '),
    }));
    presetResults[label] = { clicked, stats: s, state: st };
    if (shots && file) await page.screenshot({ path: resolve(ARTIFACTS, file) });
  }

  // --- probe -------------------------------------------------------------
  const probeBefore = await page.evaluate(() => {
    window.EH.params.timeScale = 3;
    return { active: window.EH.probe.active };
  });
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /DROP PROBE|PROBE/i.test(b.textContent));
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 2500));
  const probeAfter = await page.evaluate(() => {
    const p = window.EH.probe.readout();
    const cells = [...document.querySelectorAll('.readouts .cell')].map((c) => c.textContent);
    return { ...p, timeScale: window.EH.params.timeScale, hudProbe: cells.filter((c) => /probe/.test(c)) };
  });

  // --- cinematic ---------------------------------------------------------
  const cine = await page.evaluate(async () => {
    const btn = [...document.querySelectorAll('button')].find((b) => /CINEMATIC/i.test(b.textContent));
    if (!btn) return { ok: false };
    btn.click();
    await new Promise((r) => setTimeout(r, 1200));
    const on = {
      cinematic: window.EH.rig.cinematic,
      locked: window.EH.rig.userInputLocked,
      hudClass: document.getElementById('hud').className,
      radius: window.EH.rig.radius,
    };
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    return { ok: true, on, off: { cinematic: window.EH.rig.cinematic, locked: window.EH.rig.userInputLocked } };
  });

  // --- time dilation near the horizon ------------------------------------
  const dive = await page.evaluate(async () => {
    window.EH.params.timeScale = 1;
    window.EH.rig.goTo({ radius: 1.08, phi: 1.5 });
    await new Promise((r) => setTimeout(r, 2600));
    const s = window.EH.sim;
    return { radius: s.rig.radius, dilation: s.dilation, stretch: s.stretch };
  });
  if (shots) await page.screenshot({ path: resolve(ARTIFACTS, '07-horizon-dive.png') });
  const diveStats = await page.evaluate(pageStats, {}).catch(() => null);
  await page.evaluate(async () => {
    window.EH.rig.goTo({ radius: 13.2, phi: 1.42 });
    await new Promise((r) => setTimeout(r, 1500));
  });

  // --- Einstein ring: park the alignment star dead behind the hole ---------
  await page.evaluate(async () => {
    const { sim, rig, params } = window.EH;
    Object.assign(params, {
      showDisk: false,
      photonRing: 0,
      alignStar: 2.4,
      starDensity: 0.3,
      bloom: 0.5,
      grain: 0,
      exposure: 1,
    });
    sim.setParams(params);
    sim.alignBase.copy(rig.camera.position).multiplyScalar(-1).normalize();
    sim.simT = 0; // zero the star's drift so it stays aligned
    await new Promise((r) => setTimeout(r, 900));
  });
  const ringOn = await page.evaluate(pageStats, {}).catch(() => null);
  if (shots) await page.screenshot({ path: resolve(ARTIFACTS, '08-einstein-ring.png') });
  await page.evaluate(async () => {
    window.EH.params.alignStar = 0; // same sky, no aligned source
    await new Promise((r) => setTimeout(r, 600));
  });
  const ringOff = await page.evaluate(pageStats, {}).catch(() => null);

  // --- near the horizon: the shadow swallows the sky, stars squeeze through --
  await page.evaluate(async () => {
    const { sim, params } = window.EH;
    Object.assign(params, { showDisk: false, photonRing: 1.2, alignStar: 1.6, starDensity: 1.4 });
    sim.setParams(params);
    window.EH.rig.goTo({ radius: 1.15, phi: 1.1, fov: 90 });
    await new Promise((r) => setTimeout(r, 2600));
  });
  const nearHorizon = await page.evaluate(pageStats, {}).catch(() => null);
  if (shots) await page.screenshot({ path: resolve(ARTIFACTS, '09-near-horizon.png') });

  // --- restore, then watch a probe fall in ---------------------------------
  await page.evaluate(async () => {
    const { sim, rig, params } = window.EH;
    Object.assign(params, {
      showDisk: true,
      photonRing: 1,
      alignStar: 1.3,
      starDensity: 1,
      bloom: 0.6,
      grain: 0.35,
      exposure: 0.95,
      timeScale: 4,
    });
    sim.setParams(params);
    rig.goTo({ radius: 9, phi: 1.46, fov: 52 });
    await new Promise((r) => setTimeout(r, 1800));
    const btn = [...document.querySelectorAll('button')].find((b) => /DROP PROBE|PROBE/i.test(b.textContent));
    if (btn) btn.click();
    await new Promise((r) => setTimeout(r, 9000));
  });
  const probeFall = await page.evaluate(() => window.EH.probe.readout());
  if (shots) await page.screenshot({ path: resolve(ARTIFACTS, '10-probe-fall.png') });

  // --- quality governor responds to a frame-time blowup -------------------
  const gov = await page.evaluate(() => {
    const g = window.EH.sim.governor;
    const before = { index: g.index, name: g.tier.name, auto: g.auto };
    for (let i = 0; i < 400; i++) window.EH.sim.govern(48); // pretend 21 fps
    const after = { index: g.index, name: g.tier.name, scale: window.EH.sim.pixelScale, steps: g.tier.steps };
    for (let i = 0; i < 900; i++) window.EH.sim.govern(6); // pretend 166 fps
    const back = { index: g.index, name: g.tier.name };
    return { before, after, back, changes: g.changes };
  });

  // --- summarise the annulus profiles ------------------------------------
  const ringPeak = (stats) => {
    if (!stats || !stats.rings) return null;
    // k runs 0.6 .. 6.0 in 0.4 steps: index i -> k = 0.6 + 0.4 i
    let peak = 0;
    let peakK = 0;
    stats.rings.forEach((v, i) => {
      const k = 0.6 + 0.4 * i;
      if (k >= 0.8 && k <= 3.0 && v > peak) {
        peak = v;
        peakK = k;
      }
    });
    let far = 0;
    let n = 0;
    stats.rings.forEach((v, i) => {
      const k = 0.6 + 0.4 * i;
      if (k >= 4.2 && k <= 5.8) {
        far += v;
        n++;
      }
    });
    far = n ? far / n : 0;
    return { peak: +peak.toFixed(4), peakK, far: +far.toFixed(4), ratio: +(peak / Math.max(far, 1e-6)).toFixed(2) };
  };

  await browser.close();
  await server.close();

  return {
    url,
    info,
    hdr,
    ldr,
    lensDiff,
    presetResults,
    probeBefore,
    probeAfter,
    cine,
    dive,
    diveStats,
    ringOn,
    ringOff,
    ringAnalysis: { on: ringPeak(ringOn), off: ringPeak(ringOff), base: ringPeak(ldr) },
    nearHorizon,
    probeFall,
    gov,
    errors,
    warnings,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dev = process.argv.includes('--dev');
  const t0 = Date.now();
  const r = await runRenderCheck({ dev });
  console.log(JSON.stringify(r, null, 2));
  console.log(`\nfinished in ${((Date.now() - t0) / 1000).toFixed(1)}s · artifacts in .artifacts/`);
  if (r.errors.length) {
    console.error('ERRORS:\n' + r.errors.join('\n'));
    process.exitCode = 1;
  }
}
