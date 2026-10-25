/**
 * tests/presets.test.js — the parameter spec, the named presets and the slider
 * maths. These guard the control panel: a preset that drifts out of range or a
 * renamed key shows up here instead of as a broken slider at runtime.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PARAMS,
  PARAM_SPEC,
  PRESETS,
  PRESET_ORDER,
  RANGES,
  TOGGLES,
  applyPreset,
  clampParams,
  deriveScene,
  sliderPosition,
  sliderValue,
} from '../src/presets.js';
import { SHADOW_RADIUS_RS, horizonRadiusRs, iscoRadiusRs } from '../src/physics.js';

const RANGE_KEYS = Object.keys(PARAM_SPEC).filter((k) => PARAM_SPEC[k].type === 'range');
const BOOL_KEYS = Object.keys(PARAM_SPEC).filter((k) => PARAM_SPEC[k].type === 'bool');

describe('PARAM_SPEC', () => {
  it('describes every parameter with a label and a type', () => {
    for (const key of Object.keys(PARAM_SPEC)) {
      const spec = PARAM_SPEC[key];
      expect(typeof spec.label).toBe('string');
      expect(spec.label.length).toBeGreaterThan(0);
      expect(['range', 'bool']).toContain(spec.type);
      if (spec.type === 'range') expect(typeof spec.fmt).toBe('function');
    }
  });

  it('has sane, finite, ordered ranges', () => {
    for (const key of RANGE_KEYS) {
      const { min, max } = PARAM_SPEC[key];
      expect(Number.isFinite(min)).toBe(true);
      expect(Number.isFinite(max)).toBe(true);
      expect(min).toBeLessThan(max);
      if (!PARAM_SPEC[key].log) expect(PARAM_SPEC[key].step).toBeGreaterThan(0);
      if (PARAM_SPEC[key].log) expect(min).toBeGreaterThan(0); // log scale needs positive domain
    }
  });

  it('exposes the required controls: mass, spin, disk temperature, disk tilt, lensing, time scale', () => {
    for (const key of ['mass', 'spin', 'diskTemp', 'diskTilt', 'lensing', 'timeScale']) {
      expect(PARAM_SPEC[key], `missing parameter ${key}`).toBeDefined();
      expect(PARAM_SPEC[key].type).toBe('range');
    }
  });

  it('splits cleanly into sliders and toggles with no overlap', () => {
    expect(RANGES.length + TOGGLES.length).toBe(Object.keys(PARAM_SPEC).length);
    for (const k of TOGGLES) expect(PARAM_SPEC[k].type).toBe('bool');
    for (const k of RANGES) expect(PARAM_SPEC[k].type).toBe('range');
  });

  it('fmt() never throws or prints NaN for values at the ends of a range', () => {
    for (const key of RANGE_KEYS) {
      const { min, max } = PARAM_SPEC[key];
      for (const v of [min, (min + max) / 2, max]) {
        const text = PARAM_SPEC[key].fmt(v);
        expect(typeof text).toBe('string');
        expect(text).not.toContain('NaN');
      }
    }
  });
});

describe('DEFAULT_PARAMS', () => {
  it('covers every key in the spec', () => {
    for (const key of Object.keys(PARAM_SPEC)) {
      expect(DEFAULT_PARAMS[key], `default missing ${key}`).not.toBeUndefined();
    }
  });

  it('is already clamped (defaults are valid by construction)', () => {
    expect(clampParams(DEFAULT_PARAMS)).toEqual(DEFAULT_PARAMS);
  });

  it('has physically sensible defaults', () => {
    expect(DEFAULT_PARAMS.mass).toBeGreaterThan(1);
    expect(DEFAULT_PARAMS.spin).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_PARAMS.spin).toBeLessThan(1);
    expect(DEFAULT_PARAMS.lensing).toBeCloseTo(1, 6); // exact GR by default
    expect(DEFAULT_PARAMS.diskTemp).toBeGreaterThan(1500);
  });
});

describe('clampParams', () => {
  it('clamps out-of-range numbers into the slider range', () => {
    const p = clampParams({ mass: 1e30, spin: -3, lensing: 99, timeScale: -5 });
    expect(p.mass).toBe(PARAM_SPEC.mass.max);
    expect(p.spin).toBe(0);
    expect(p.lensing).toBe(PARAM_SPEC.lensing.max);
    expect(p.timeScale).toBe(0);
  });

  it('falls back to the default for garbage input', () => {
    const p = clampParams({ mass: 'banana', spin: NaN, diskTemp: undefined, lensing: null });
    expect(p.mass).toBe(DEFAULT_PARAMS.mass);
    expect(p.spin).toBe(DEFAULT_PARAMS.spin);
    expect(p.diskTemp).toBe(DEFAULT_PARAMS.diskTemp);
    expect(p.lensing).toBe(DEFAULT_PARAMS.lensing);
  });

  it('coerces toggles to booleans and ignores unknown keys', () => {
    const p = clampParams({ showDisk: 'yes', showStars: 0, nonsense: 42 });
    expect(p.showDisk).toBe(true);
    expect(p.showStars).toBe(false);
    expect('nonsense' in p).toBe(false);
  });

  it('returns a fresh object every call (no shared state)', () => {
    const a = clampParams(DEFAULT_PARAMS);
    const b = clampParams(DEFAULT_PARAMS);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe('named presets', () => {
  it('ships the three required presets: Gargantua, Sagittarius A*, Quiet', () => {
    for (const name of ['gargantua', 'sgra', 'quiet']) {
      expect(PRESETS[name], `missing preset ${name}`).toBeDefined();
      expect(PRESET_ORDER).toContain(name);
      expect(typeof PRESETS[name].label).toBe('string');
      expect(PRESETS[name].label.length).toBeGreaterThan(0);
      expect(typeof PRESETS[name].note).toBe('string');
      expect(PRESETS[name].note.length).toBeGreaterThan(10);
    }
    expect(PRESETS.gargantua.label).toMatch(/Gargantua/);
    expect(PRESETS.sgra.label).toMatch(/Sagittarius/);
    expect(PRESETS.quiet.label).toMatch(/Quiet/);
  });

  it('lists only presets that exist', () => {
    for (const name of PRESET_ORDER) expect(PRESETS[name]).toBeDefined();
  });

  it('only uses parameters that exist in the spec', () => {
    for (const name of Object.keys(PRESETS)) {
      for (const key of Object.keys(PRESETS[name].params)) {
        expect(PARAM_SPEC[key], `${name} sets unknown parameter ${key}`).toBeDefined();
      }
    }
  });

  it('every preset value is already inside its control range', () => {
    for (const name of Object.keys(PRESETS)) {
      const params = PRESETS[name].params;
      for (const [key, value] of Object.entries(params)) {
        const spec = PARAM_SPEC[key];
        if (spec.type === 'bool') {
          expect(typeof value, `${name}.${key} should be boolean`).toBe('boolean');
        } else {
          expect(Number.isFinite(value), `${name}.${key} should be finite`).toBe(true);
          expect(value, `${name}.${key} below min`).toBeGreaterThanOrEqual(spec.min);
          expect(value, `${name}.${key} above max`).toBeLessThanOrEqual(spec.max);
        }
      }
    }
  });

  it('presets are physically sane', () => {
    for (const name of Object.keys(PRESETS)) {
      const p = PRESETS[name].params;
      expect(p.spin).toBeGreaterThanOrEqual(0);
      expect(p.spin).toBeLessThan(1);
      expect(iscoRadiusRs(p.spin)).toBeGreaterThan(0.5);
      expect(iscoRadiusRs(p.spin)).toBeLessThanOrEqual(3 + 1e-9);
      expect(p.lensing).toBeGreaterThanOrEqual(0);
      expect(p.mass).toBeGreaterThan(1);
    }
  });

  it('the presets are actually different from each other', () => {
    const g = PRESETS.gargantua.params;
    const s = PRESETS.sgra.params;
    const q = PRESETS.quiet.params;
    expect(g.mass).toBeGreaterThan(s.mass); // 1.6e8 vs 4.3e6
    expect(q.mass).toBeGreaterThan(s.mass); // Quiet is a quiet giant, not a dwarf
    expect(q.diskBrightness).toBeLessThan(0.2); // "Quiet" has almost no disk
    expect(q.timeScale).toBeLessThan(0.5); // "Quiet" really is slow
    expect(g.spin).toBeGreaterThan(s.spin);
    expect(new Set(Object.keys(PRESETS).map((k) => JSON.stringify(PRESETS[k].params))).size).toBe(
      Object.keys(PRESETS).length,
    );
  });

  it('Gargantua keeps the near-extremal spin that makes its disk famous', () => {
    expect(PRESETS.gargantua.params.spin).toBeGreaterThan(0.9);
    // a high spin drags the ISCO well inside the Schwarzschild value of 3 r_s
    expect(iscoRadiusRs(PRESETS.gargantua.params.spin)).toBeLessThan(1.5);
  });
});

describe('applyPreset', () => {
  it('returns fully valid parameters built from the preset', () => {
    for (const name of PRESET_ORDER) {
      const p = applyPreset(name, {});
      expect(p).toEqual(clampParams(p));
      for (const key of Object.keys(PARAM_SPEC)) expect(p[key]).not.toBeUndefined();
    }
  });

  it('layers the preset on top of the current parameters', () => {
    const before = clampParams({ ...DEFAULT_PARAMS, grain: 0.9, showProbe: false });
    const after = applyPreset('gargantua', before);
    // grain is set by the preset, showProbe is not -> keeps the user's choice
    expect(after.grain).toBe(PRESETS.gargantua.params.grain);
    expect(after.showProbe).toBe(false);
  });

  it('does not mutate its inputs or the preset data', () => {
    const before = clampParams(DEFAULT_PARAMS);
    const snapshot = JSON.stringify(before);
    const presetSnapshot = JSON.stringify(PRESETS);
    applyPreset('sgra', before);
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(JSON.stringify(PRESETS)).toBe(presetSnapshot);
  });

  it('is case-insensitive and rejects unknown names with a helpful error', () => {
    expect(applyPreset('GARGANTUA', {})).toEqual(applyPreset('gargantua', {}));
    expect(() => applyPreset('cygnus-x-9', {})).toThrow(RangeError);
    expect(() => applyPreset(undefined, {})).toThrow(RangeError);
    try {
      applyPreset('nope', {});
    } catch (err) {
      expect(err.message).toContain('gargantua');
    }
  });
});

describe('slider maths', () => {
  it('round-trips linear sliders through position/value', () => {
    for (const key of RANGES.filter((k) => !PARAM_SPEC[k].log)) {
      const spec = PARAM_SPEC[key];
      for (const t of [0, 0.13, 0.5, 0.77, 1]) {
        const v = sliderValue(key, t);
        expect(v).toBeGreaterThanOrEqual(spec.min);
        expect(v).toBeLessThanOrEqual(spec.max);
        if (spec.step) expect(v / spec.step).toBeCloseTo(Math.round(v / spec.step), 6);
        expect(sliderPosition(key, v)).toBeCloseTo(t, 2);
      }
    }
  });

  it('round-trips the log mass slider across nine decades', () => {
    const values = [3, 21, 1e4, 4.3e6, 1.6e8, 1e9];
    for (const v of values) {
      const t = sliderPosition('mass', v);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
      expect(sliderValue('mass', t)).toBeCloseTo(v, Math.max(0, 6 - Math.floor(Math.log10(v))));
    }
    expect(sliderPosition('mass', PARAM_SPEC.mass.min)).toBeCloseTo(0, 9);
    expect(sliderPosition('mass', PARAM_SPEC.mass.max)).toBeCloseTo(1, 9);
  });

  it('clamps slider positions outside [0,1] instead of escaping the range', () => {
    expect(sliderValue('spin', -3)).toBe(PARAM_SPEC.spin.min);
    expect(sliderValue('spin', 42)).toBeLessThanOrEqual(PARAM_SPEC.spin.max);
    expect(sliderPosition('mass', -1)).toBe(0);
    expect(sliderPosition('mass', 1e30)).toBe(1);
    expect(sliderValue('not-a-key', 0.5)).toBe(0);
    expect(sliderPosition('not-a-key', 5)).toBe(0);
    expect(sliderValue('showDisk', 0.5)).toBe(0); // bools have no slider
  });

  it('monotonically increases along the track', () => {
    for (const key of RANGES) {
      let prev = -Infinity;
      for (let t = 0; t <= 1.0001; t += 0.02) {
        const v = sliderValue(key, t);
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
  });
});

describe('deriveScene', () => {
  it('derives a disk that starts at the ISCO and lies outside the shadow', () => {
    for (const name of PRESET_ORDER) {
      const p = applyPreset(name, {});
      const d = deriveScene(p);
      const floor = horizonRadiusRs(p.spin) * 1.04;
      expect(d.diskInner).toBeCloseTo(Math.max(iscoRadiusRs(p.spin), floor), 9);
      expect(d.diskInner).toBeGreaterThan(horizonRadiusRs(p.spin)); // outside the horizon
      expect(d.diskOuter).toBeGreaterThan(d.diskInner * 2);
      expect(d.diskOuter).toBeGreaterThan(SHADOW_RADIUS_RS); // visible around the shadow
      expect(Number.isFinite(d.diskFlowRate)).toBe(true);
      expect(d.diskFlowRate).toBeGreaterThan(0);
    }
  });

  it('shrinks the inner edge as spin grows and never lets it inside the horizon', () => {
    const slow = deriveScene(clampParams({ ...DEFAULT_PARAMS, spin: 0 }));
    const fast = deriveScene(clampParams({ ...DEFAULT_PARAMS, spin: 0.95 }));
    expect(fast.diskInner).toBeLessThan(slow.diskInner);
    expect(slow.diskInner).toBeCloseTo(3, 6);
    expect(fast.diskInner).toBeGreaterThan(horizonRadiusRs(0.95)); // but never inside the hole
  });

  it('compresses disk evolution so heavy holes churn slower than stellar ones', () => {
    const heavy = deriveScene(clampParams({ ...DEFAULT_PARAMS, mass: 1e9 }));
    const light = deriveScene(clampParams({ ...DEFAULT_PARAMS, mass: 5 }));
    expect(heavy.diskFlowRate).toBeLessThan(light.diskFlowRate);
    expect(light.diskFlowRate).toBeLessThanOrEqual(3.2);
    expect(heavy.diskFlowRate).toBeGreaterThanOrEqual(0.09);
  });

  it('survives extreme parameters without producing NaN', () => {
    for (const p of [
      clampParams({ mass: 1e9, spin: 0.998, diskTemp: 30000 }),
      clampParams({ mass: 3, spin: 0, diskTemp: 1500 }),
    ]) {
      const d = deriveScene(p);
      for (const v of Object.values(d)) expect(Number.isFinite(v)).toBe(true);
    }
  });
});
