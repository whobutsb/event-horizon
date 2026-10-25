/**
 * tests/render.browser.test.js — end-to-end render verification.
 *
 * Serves the production build, drives it in a real Chromium-family browser with
 * WebGL2 (Metal/ANGLE), reads pixels back out of the GPU and asserts on things
 * that only a rendered frame can prove: the shadow really is black, light really
 * bends, presets really change the picture, the probe really falls, and the
 * quality governor really reacts.
 *
 * Skips itself when there is no browser (CI without Chrome) or when
 * EH_SKIP_BROWSER=1. Set EH_SHOTS=1 to also write .artifacts/*.png.
 *
 * This is slow (it boots a GPU context), so it lives in its own file with a
 * generous timeout. `npm run test:unit` skips it; `npm run verify` runs it.
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { findBrowser } from '../scripts/browser.mjs';

const browserPath = process.env.EH_SKIP_BROWSER ? null : findBrowser();
const distReady = existsSync(resolve(process.cwd(), 'dist/index.html'));
const runnable = Boolean(browserPath) && distReady;

const suite = runnable ? describe : describe.skip;

if (!runnable) {
  console.warn(
    '[render] skipped — ' +
      (!browserPath ? 'no Chromium-family browser found (set EH_BROWSER)' : 'run `npm run build` first'),
  );
}

suite('renders in a real browser', () => {
  it(
    'draws a lensed black hole and behaves under interaction',
    async () => {
      const { runRenderCheck } = await import('../scripts/render-check.mjs');
      const r = await runRenderCheck({
        dev: false,
        verbose: false,
        shots: Boolean(process.env.EH_SHOTS),
      });

      // --- nothing complained -------------------------------------------
      expect(r.errors).toEqual([]);

      // --- a real WebGL2 program ran at an interactive rate --------------
      expect(r.info.programs).toBeGreaterThanOrEqual(4);
      expect(r.info.width).toBeGreaterThan(100);
      expect(r.info.fps).toBeGreaterThan(25);
      expect(r.info.gl).toMatch(/ANGLE|OpenGL|Metal|SwiftShader/i);

      // --- the frame has real dynamic range ------------------------------
      expect(r.hdr.max).toBeGreaterThan(0.5); // HDR target holds clipped highlights
      expect(r.hdr.mean).toBeGreaterThan(0);
      expect(r.ldr.max).toBeGreaterThan(0.6);
      expect(r.ldr.mean).toBeGreaterThan(0.02);

      // --- the event horizon is genuinely black --------------------------
      // anchored to where the hole projects, so it survives auto-pan/presets
      expect(r.ldr.pose.radius).toBeGreaterThan(0.02);
      expect(r.ldr.centre).toBeLessThan(0.06); // dead centre: nothing escapes
      expect(r.hdr.centre).toBeLessThan(0.01);
      // the interior stays far darker than the lensed ring around it
      expect(r.ldr.shadowMean).toBeLessThan(0.3);
      expect(r.ldr.shadowMean).toBeLessThan(r.ringAnalysis.base.peak * 0.6);

      // --- light is bent: a bright lensed ring around a dark centre ------
      expect(r.ringAnalysis.base.peak).toBeGreaterThan(0.1);
      expect(r.ringAnalysis.base.ratio).toBeGreaterThan(3);

      // --- turning lensing off changes the picture -----------------------
      expect(r.lensDiff).toBeGreaterThan(0.02);

      // --- every preset is wired and produces a frame --------------------
      for (const [label, p] of Object.entries(r.presetResults)) {
        expect(p.clicked, `preset button ${label}`).toBe(true);
        expect(p.stats?.max, `preset ${label} rendered`).toBeGreaterThan(0.3);
        expect(Number.isFinite(p.state.mass)).toBe(true);
      }
      // presets must actually differ from each other
      const spins = Object.values(r.presetResults).map((p) => p.state.spin);
      expect(Math.max(...spins) - Math.min(...spins)).toBeGreaterThan(0.3);

      // --- the probe falls, reddens and stretches -----------------------
      expect(r.probeBefore.active).toBe(false); // no probe before the button is pressed
      expect(r.probeAfter.active).toBe(true);
      expect(r.probeAfter.r0).toBeGreaterThan(3); // released from the ship's radius
      expect(r.probeAfter.r).toBeLessThan(r.probeAfter.r0);
      expect(r.probeAfter.g).toBeLessThan(1);
      expect(r.probeAfter.stretch).toBeGreaterThan(1);

      // --- dropping deeper keeps redshifting towards zero ----------------
      expect(r.probeFall.r).toBeLessThan(r.probeAfter.r);
      expect(r.probeFall.g).toBeLessThan(r.probeAfter.g);
      expect(r.probeFall.stretch).toBeGreaterThan(r.probeAfter.stretch);

      // --- dropping a probe must be *visible* (frame differencing: the same
      // moment with the probe hidden vs drawn) -----------------------------
      expect(r.probeVis.alpha).toBeGreaterThan(0.2);
      for (const where of ['dark', 'busy']) {
        const v = r.probeVis[where];
        expect(v.maxDelta, `probe contrast over ${where} background`).toBeGreaterThan(0.25);
        expect(v.changedPx, `probe pixel footprint over ${where} background`).toBeGreaterThan(150);
        expect(v.peakWithProbe).toBeGreaterThan(0.4);
      }
      // the button stays actionable: a second drop restarts the fall
      expect(r.probeVis.redropped).toBe(true);
      expect(r.probeVis.rAfterRedrop).toBeGreaterThan(r.probeVis.rBeforeRedrop);
      expect(r.probeVis.r).toBeLessThan(r.probeVis.rAfterRedrop + 0.01);

      // --- cinematic mode must be escapable ------------------------------
      expect(r.cineExit.ok).toBe(true);
      expect(r.cineExit.entered).toBe(true);
      expect(r.cineExit.pill.visible).toBe(true);
      expect(r.cineExit.pill.clickable).toBe(true); // hit-testable while chrome fades
      expect(r.cineExit.pill.onScreen).toBe(true);
      expect(r.cineExit.clickedExits).toBe(true);
      expect(r.cineExit.keyEntered).toBe(true); // a focused slider must not eat 'C'
      expect(r.cineExit.focusStillTrapped).toBe(true); // ...even while it holds focus
      expect(r.cineExit.escExits).toBe(true);

      // --- cinematic mode takes the controls, then gives them back -------
      expect(r.cine.ok).toBe(true);
      expect(r.cine.on.cinematic).toBe(true);
      expect(r.cine.on.locked).toBe(true);
      expect(r.cine.off.cinematic).toBe(false);
      expect(r.cine.off.locked).toBe(false);

      // --- close to the horizon the ship clock runs slow -----------------
      expect(r.dive.radius).toBeLessThan(1.2);
      expect(r.dive.dilation).toBeLessThan(0.45);
      // sky smearing ramps up with dilation (0 far away, 1 grazing the horizon)
      expect(r.dive.stretch).toBeGreaterThan(0.8);
      expect(r.dive.stretch).toBeLessThanOrEqual(1);

      // --- ...but the view is not simply black: the lens opens and pans --
      expect(r.nearHorizon.max).toBeGreaterThan(0.15);

      // --- an aligned background source lights up an Einstein ring -------
      expect(r.ringOn.mean).toBeGreaterThan(r.ringOff.mean * 2.5);
      expect(r.ringOn.fracBright).toBeGreaterThan(r.ringOff.fracBright * 5);

      // --- the quality governor degrades under load and recovers ---------
      expect(r.gov.before.auto).toBe(true);
      expect(r.gov.after.index).toBeGreaterThan(r.gov.before.index);
      expect(r.gov.changes).toBeGreaterThanOrEqual(1);
    },
    300_000,
  );
});
