/**
 * presets.js — the parameter spec that drives the control panel, plus the
 * named presets. Pure data + pure functions so it can be unit tested
 * (tests/presets.test.js) and reused by the UI without touching the DOM.
 */

import { clamp, horizonRadiusRs, iscoRadiusRs, logMap, logUnmap } from './physics.js';

/**
 * Every controllable parameter. `type` is either "range" or "bool".
 * Range entries carry min/max/step (and optional log scaling) which the UI
 * turns into a slider; clampParams() uses them as the single source of truth.
 */
export const PARAM_SPEC = {
  mass: {
    label: 'Mass',
    type: 'range',
    unit: 'M☉',
    min: 3,
    max: 1e9,
    log: true,
    fmt: (v) => (v < 1e4 ? v.toFixed(1) : v.toExponential(2).replace('e+', 'e')),
  },
  spin: {
    label: 'Spin a★',
    type: 'range',
    unit: '',
    min: 0,
    max: 0.998,
    step: 0.002,
    fmt: (v) => v.toFixed(3),
  },
  diskTemp: {
    label: 'Disk temp',
    type: 'range',
    unit: 'K',
    min: 1500,
    max: 30000,
    step: 50,
    fmt: (v) => `${Math.round(v)} K`,
  },
  diskTilt: {
    label: 'Disk tilt',
    type: 'range',
    unit: '°',
    min: -80,
    max: 80,
    step: 0.5,
    fmt: (v) => `${v.toFixed(1)}°`,
  },
  lensing: {
    label: 'Lensing',
    type: 'range',
    unit: '×',
    min: 0,
    max: 2.5,
    step: 0.01,
    fmt: (v) => `${v.toFixed(2)}×`,
  },
  timeScale: {
    label: 'Time scale',
    type: 'range',
    unit: '×',
    min: 0,
    max: 4,
    step: 0.01,
    fmt: (v) => `${v.toFixed(2)}×`,
  },
  diskBrightness: {
    label: 'Disk glow',
    type: 'range',
    unit: '×',
    min: 0,
    max: 3,
    step: 0.01,
    fmt: (v) => `${v.toFixed(2)}×`,
  },
  photonRing: {
    label: 'Photon ring',
    type: 'range',
    unit: '×',
    min: 0,
    max: 2.5,
    step: 0.01,
    fmt: (v) => `${v.toFixed(2)}×`,
  },
  starDensity: {
    label: 'Starfield',
    type: 'range',
    unit: '×',
    min: 0,
    max: 2,
    step: 0.01,
    fmt: (v) => `${v.toFixed(2)}×`,
  },
  alignStar: {
    label: 'Align star',
    type: 'range',
    unit: '',
    min: 0,
    max: 2.5,
    step: 0.01,
    fmt: (v) => (v < 0.01 ? 'off' : v.toFixed(2)),
  },
  exposure: {
    label: 'Exposure',
    type: 'range',
    unit: '×',
    min: 0.15,
    max: 3,
    step: 0.01,
    fmt: (v) => `${v.toFixed(2)}×`,
  },
  bloom: {
    label: 'Bloom',
    type: 'range',
    unit: '',
    min: 0,
    max: 2,
    step: 0.01,
    fmt: (v) => v.toFixed(2),
  },
  grain: {
    label: 'Film grain',
    type: 'range',
    unit: '',
    min: 0,
    max: 1,
    step: 0.01,
    fmt: (v) => v.toFixed(2),
  },
  showDisk: { label: 'Accretion disk', type: 'bool' },
  showStars: { label: 'Starfield', type: 'bool' },
  showGalaxy: { label: 'Galaxy band', type: 'bool' },
  showProbe: { label: 'Probe trail', type: 'bool' },
};

/** Boolean parameters, for the UI to group them. */
export const TOGGLES = Object.keys(PARAM_SPEC).filter((k) => PARAM_SPEC[k].type === 'bool');
/** Slider parameters. */
export const RANGES = Object.keys(PARAM_SPEC).filter((k) => PARAM_SPEC[k].type === 'range');

export const DEFAULT_PARAMS = {
  mass: 1.6e8,
  spin: 0.9,
  diskTemp: 7400,
  diskTilt: 0,
  lensing: 1,
  timeScale: 1,
  diskBrightness: 1.15,
  photonRing: 1,
  starDensity: 1,
  alignStar: 1.3,
  exposure: 0.95,
  bloom: 0.6,
  grain: 0.35,
  showDisk: true,
  showStars: true,
  showGalaxy: true,
  showProbe: true,
};

/**
 * Named presets. Values are clamped through PARAM_SPEC by applyPreset(), so a
 * typo can never produce an out-of-range parameter.
 */
export const PRESETS = {
  gargantua: {
    label: 'Gargantua',
    note: 'Near-extremal spin, thin bright disk, gentle churn — the Interstellar look.',
    params: {
      mass: 1.6e8,
      spin: 0.92,
      diskTemp: 7400,
      diskTilt: 0,
      lensing: 1,
      timeScale: 1,
      diskBrightness: 1.2,
      photonRing: 1,
      starDensity: 1,
      alignStar: 1.3,
      exposure: 0.95,
      bloom: 0.6,
      grain: 0.35,
      showDisk: true,
      showStars: true,
      showGalaxy: true,
    },
  },
  sgra: {
    label: 'Sagittarius A★',
    note: '4.3 million M☉ at the Galactic centre: hot inner flow, weak beaming, dust in the way.',
    params: {
      mass: 4.3e6,
      spin: 0.65,
      diskTemp: 4200,
      diskTilt: 17,
      lensing: 1,
      timeScale: 1.6,
      diskBrightness: 0.8,
      photonRing: 1.35,
      starDensity: 1.55,
      alignStar: 0.55,
      exposure: 1.0,
      bloom: 0.55,
      grain: 0.45,
      showDisk: true,
      showStars: true,
      showGalaxy: true,
    },
  },
  quiet: {
    label: 'Quiet',
    note: 'Adrift, no disk, no boost — just an unilluminated hole and a very still sky.',
    params: {
      mass: 6e7,
      spin: 0.2,
      diskTemp: 2600,
      diskTilt: -8,
      lensing: 1,
      timeScale: 0.12,
      diskBrightness: 0.06,
      photonRing: 0.5,
      starDensity: 1.35,
      alignStar: 1.9,
      exposure: 1.0,
      bloom: 0.42,
      grain: 0.2,
      showDisk: true,
      showStars: true,
      showGalaxy: true,
    },
  },
  cygnus: {
    label: 'Cygnus X-1',
    note: 'Bonus: 21 M☉ stellar hole — blue-white, violently fast, extreme beaming.',
    params: {
      mass: 21,
      spin: 0.97,
      diskTemp: 19500,
      diskTilt: 6,
      lensing: 1,
      timeScale: 3.2,
      diskBrightness: 1.45,
      photonRing: 1.1,
      starDensity: 0.9,
      alignStar: 0.8,
      exposure: 0.85,
      bloom: 0.7,
      grain: 0.3,
      showDisk: true,
      showStars: true,
      showGalaxy: false,
    },
  },
};

export const PRESET_ORDER = ['gargantua', 'sgra', 'quiet', 'cygnus'];

/** Clamp/coerce an arbitrary parameter bag into a valid one. */
export function clampParams(input = {}) {
  const out = {};
  for (const key of Object.keys(PARAM_SPEC)) {
    const spec = PARAM_SPEC[key];
    const raw = input[key] !== undefined && input[key] !== null ? input[key] : DEFAULT_PARAMS[key];
    if (spec.type === 'bool') {
      out[key] = Boolean(raw);
    } else {
      const v = Number(raw);
      out[key] = Number.isFinite(v) ? clamp(v, spec.min, spec.max) : DEFAULT_PARAMS[key];
    }
  }
  return out;
}

/** Slider position (0..1) for a parameter, honouring log scales. */
export function sliderPosition(key, value) {
  const spec = PARAM_SPEC[key];
  if (!spec || spec.type !== 'range') return 0;
  return spec.log ? logUnmap(clamp(value, spec.min, spec.max), spec.min, spec.max) : (clamp(value, spec.min, spec.max) - spec.min) / (spec.max - spec.min);
}

/** Value from a slider position (0..1). */
export function sliderValue(key, t) {
  const spec = PARAM_SPEC[key];
  if (!spec || spec.type !== 'range') return 0;
  const u = clamp(t, 0, 1);
  const v = spec.log ? logMap(u, spec.min, spec.max) : spec.min + u * (spec.max - spec.min);
  // snap to step for linear sliders so readouts stay tidy
  const snapped = spec.step && !spec.log ? Math.round(v / spec.step) * spec.step : v;
  return clamp(snapped, spec.min, spec.max);
}

/** Apply a named preset on top of the current parameters. Throws if unknown. */
export function applyPreset(name, currentParams = {}) {
  const key = String(name).toLowerCase();
  const preset = PRESETS[key];
  if (!preset) throw new RangeError(`Unknown preset "${name}" (have: ${PRESET_ORDER.join(', ')})`);
  return clampParams({ ...currentParams, ...preset.params });
}

/** Scene-space values derived from the parameters (renderer works in r_s units). */
export function deriveScene(params) {
  // a fast hole drags the ISCO down towards the horizon; never let the disk
  // start inside the horizon itself
  const inner = Math.max(iscoRadiusRs(params.spin), horizonRadiusRs(params.spin) * 1.04);
  return {
    diskInner: inner,
    diskOuter: Math.max(5.5, inner * 2.4 + 3.6),
    // Disk evolution is time-compressed for viewing (a real 1.6e8 M☉ hole changes
    // on hour timescales). The M-dependence keeps its correct *sign*: heavy holes
    // churn slower, stellar-mass holes flicker fast.
    diskFlowRate: clamp(1.05 * Math.pow(params.mass / 1e8, -0.1), 0.09, 3.2),
  };
}
