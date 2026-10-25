/**
 * main.js — wires the modules together and runs the frame loop.
 *
 *   physics.js    pure maths (unit tested)
 *   presets.js    parameter spec + named presets (unit tested)
 *   camera.js     orbit / zoom / fly-in / cinematic path
 *   probe.js      the dropped probe's geodesic
 *   shaders/      GLSL: raymarch + post chain
 *   scene.js      renderer, render graph, clocks, quality governor
 *   ui.js         HUD + control panel
 */

import './style.css';
import {
  DEFAULT_PARAMS,
  PRESETS,
  applyPreset,
  clampParams,
} from './presets.js';
import {
  SHADOW_RADIUS_RS,
  characteristicDiskTemperature,
  clamp,
  schwarzschildRadiusKm,
  geometricTimeSeconds,
} from './physics.js';
import { CameraRig, attachCameraInput } from './camera.js';
import { Probe } from './probe.js';
import { QUALITY_TIERS, Simulator } from './scene.js';
import { UI } from './ui.js';

const HOME = { radius: 16.5, theta: -0.75, phi: 1.36, fov: 52 };

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const params = clampParams(applyPreset('gargantua', DEFAULT_PARAMS));
let flyMode = false;
let cinematic = false;

const canvas = document.getElementById('view');
const rig = new CameraRig(HOME);
rig.update(0.016); // settle the camera so the scene can seed itself from it
const probe = new Probe();
const sim = new Simulator(canvas, { params, rig, probe });

const ui = new UI(document.getElementById('hud'), {
  params,
  onParam: (key, value) => {
    params[key] = value;
    sim.setParams(params);
  },
  onPreset: (name) => loadPreset(name),
  onAction: (action, value) => doAction(action, value),
});

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

function loadPreset(name) {
  Object.assign(params, applyPreset(name, params));
  sim.setParams(params);
  ui.refresh();
  ui.markPreset(name);
  const d = sim.derived;
  ui.toast(
    `${PRESETS[name].label} · r_s ${schwarzschildRadiusKm(params.mass).toExponential(2)} km · disk ${d.diskInner.toFixed(
      2,
    )}–${d.diskOuter.toFixed(1)} r_s`,
    3400,
  );
}

function doAction(action, value) {
  switch (action) {
    case 'probe': {
      const b = rig.basis();
      probe.drop({ camPos: rig.camera.position, camUp: b.up, camRight: b.right, rObs: rig.radius });
      ui.toast(`probe released at ${probe.r0.toFixed(2)} r_s`);
      break;
    }
    case 'fly':
      flyMode = !flyMode;
      ui.setFlyArmed(flyMode);
      ui.toast(flyMode ? 'thrust: falling towards the horizon' : 'thrust cut');
      break;
    case 'hold':
      flyMode = false;
      rig.setThrust(0);
      ui.setFlyArmed(false);
      break;
    case 'cinematic':
      setCinematic(!cinematic);
      break;
    case 'reset':
      setCinematic(false);
      flyMode = false;
      ui.setFlyArmed(false);
      rig.goTo(HOME);
      ui.toast('view reset');
      break;
    case 'quality':
      if (value === 'auto') {
        sim.governor.auto = true;
        ui.toast('quality: adaptive');
      } else {
        sim.governor.setTier(Number(value));
        sim.applyTier();
        ui.toast(`quality locked to ${QUALITY_TIERS[sim.governor.index].name}`);
      }
      break;
    default:
      break;
  }
}

function setCinematic(on) {
  cinematic = on;
  if (on) {
    flyMode = false;
    ui.setFlyArmed(false);
    rig.startCinematic();
  } else {
    rig.stopCinematic();
  }
  ui.setCinematic(on);
}

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------
attachCameraInput(rig, canvas);

const keys = new Set();
window.addEventListener('keydown', (e) => {
  const t = e.target;
  const tag = (t && t.tagName) || '';
  const itype = ((t && t.type) || '').toLowerCase();
  // typing in a field must not drive the ship — but a slider or checkbox that
  // still holds focus must never swallow the shortcuts either, otherwise
  // cinematic mode feels impossible to leave
  if (tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (tag === 'INPUT' && itype !== 'range' && itype !== 'checkbox' && itype !== 'radio') return;
  const k = e.key.toLowerCase();
  // let arrows tune a focused slider instead of orbiting the camera
  if (tag === 'INPUT' && itype === 'range' && k.startsWith('arrow')) return;
  if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
  if (e.repeat) return;
  keys.add(k);
  if (k === 'p') doAction('probe');
  else if (k === 'f') doAction('fly');
  else if (k === 'c') doAction('cinematic');
  else if (k === 'h') ui.toast(ui.toggleHud() ? 'hud hidden' : 'hud visible');
  else if (k === 'r') doAction('reset');
  else if (k === ' ') doAction('hold');
  else if (k === 'escape' && cinematic) {
    setCinematic(false);
    ui.toast('cinematic off');
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

// ---------------------------------------------------------------------------
// resize
// ---------------------------------------------------------------------------

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  sim.setSize(w, h);
  rig.camera.aspect = w / Math.max(1, h);
  rig.camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------
// frame loop
// ---------------------------------------------------------------------------

const readouts = {
  massSolar: params.mass,
  rsKm: 0,
  rCam: 0,
  rCamKm: 0,
  isco: 3,
  shadow: SHADOW_RADIUS_RS,
  gm3: 0,
  tMax: 0,
  probe: probe.readout(),
  localClock: 0,
  distantClock: 0,
  dilation: 1,
  tScaleSec: 1,
};

let last = performance.now();
let booted = false;

function tick(now) {
  const dtWall = clamp((now - last) / 1000, 0.0001, 0.25);
  last = now;

  // held-key flight controls
  if (cinematic) {
    rig.setThrust(0);
  } else if (keys.has('w') || keys.has('arrowup')) {
    rig.setThrust(1);
  } else if (keys.has('s') || keys.has('arrowdown')) {
    rig.setThrust(-1);
  } else {
    rig.setThrust(flyMode ? 1 : 0);
  }
  if (keys.has('a') || keys.has('arrowleft')) rig.orbit(-320 * dtWall, 0);
  if (keys.has('d') || keys.has('arrowright')) rig.orbit(320 * dtWall, 0);

  sim.frame(dtWall);
  const stats = sim.govern(dtWall * 1000);
  stats.cinematicProgress = cinematic ? rig.cinematicProgress : 0;
  stats.fov = rig.effectiveFov ?? rig.fov;
  stats.widen = rig.widen ?? 1;
  stats.lookAway = ((rig.lookAway ?? 0) * 180) / Math.PI;
  ui.setStats(stats);

  // telemetry
  const rsKm = schwarzschildRadiusKm(params.mass);
  readouts.massSolar = params.mass;
  readouts.rsKm = rsKm;
  readouts.rCam = rig.radius;
  readouts.rCamKm = rig.radius * rsKm;
  readouts.isco = sim.derived.diskInner;
  readouts.gm3 = geometricTimeSeconds(params.mass);
  readouts.tMax = characteristicDiskTemperature(params.mass, 0.1);
  readouts.probe = probe.readout();
  readouts.localClock = sim.localT;
  readouts.distantClock = sim.simT;
  readouts.dilation = sim.dilation;
  // one unit of our time = r_s/c of proper time for this mass
  readouts.tScaleSec = (rsKm * 1000) / 299792458;
  ui.setReadouts(readouts);

  if (!booted) {
    booted = true;
    const boot = document.getElementById('boot');
    if (boot) {
      boot.classList.add('gone');
      setTimeout(() => boot.remove(), 900);
    }
    ui.toast('drag to orbit · wheel to zoom · P to drop a probe', 5200);
  }
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);

// expose a tiny handle for debugging / automated smoke tests
window.EH = { sim, rig, probe, params, ui, QUALITY_TIERS };
