/**
 * ui.js — the HUD and control panel, built programmatically (no markup assets).
 *
 * Exposes a tiny imperative API used by main.js:
 *   new UI(rootEl, { params, onParam, onPreset, onAction })
 *   ui.refresh()            re-sync every widget from params
 *   ui.setReadouts(obj)     throttled numeric readouts
 *   ui.setStats(obj)        fps / quality tier / render scale
 *   ui.setCinematic(bool)   hide the chrome for recording
 */

import { PARAM_SPEC, PRESETS, PRESET_ORDER, sliderPosition, sliderValue } from './presets.js';
import { formatClock, formatDistanceKm, formatSci } from './physics.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

export class UI {
  constructor(root, { params, onParam, onPreset, onAction }) {
    this.root = root;
    this.params = params;
    this.onParam = onParam;
    this.onPreset = onPreset;
    this.onAction = onAction;
    this.sliders = {};
    this.toggles = {};
    this.hudHidden = false;
    this.cinematic = false;
    this.activePreset = 'gargantua';
    this._lastReadout = 0;
    this._readoutCache = {};

    this._build();
  }

  // ------------------------------------------------------------- build ----

  _build() {
    const root = this.root;
    root.innerHTML = '';

    // ---- top bar: identity + clocks ------------------------------------
    const top = el('div', 'hud-top');
    const brand = el('div', 'brand');
    brand.append(el('h1', null, 'EVENT HORIZON'), el('span', 'sub', 'schwarzschild raytracer · procedural'));
    top.append(brand);

    this.clockBox = el('div', 'clocks');
    this.clockShip = this._clock('ship clock · dτ', 'ship');
    this.clockFar = this._clock('distant clock · t', 'far');
    const dilWrap = el('div', 'clock dil-wrap');
    this.dilValue = el('b', 'big', '1.0000');
    dilWrap.append(el('span', 'lbl', 'time dilation dτ/dt'), this.dilValue, el('i', 'warn', 'gravitational'));
    this.clockBox.append(this.clockShip, this.clockFar, dilWrap);
    top.append(this.clockBox);

    const rec = el('div', 'rec');
    rec.append(el('span', 'dot'), el('span', null, 'REC'));
    this.recBadge = rec;
    top.append(rec);
    root.append(top);

    // ---- bottom-left readouts ------------------------------------------
    const panel = el('div', 'readouts');
    this.readoutTitle = el('div', 'panel-title', 'TELEMETRY');
    panel.append(this.readoutTitle);
    const grid = el('div', 'grid');
    this.readouts = {};
    const FIELDS = [
      ['mass', 'mass (M☉)'],
      ['rs', 'schwarzschild radius'],
      ['rcam', 'ship radius'],
      ['isco', 'ISCO'],
      ['shadow', 'shadow radius'],
      ['photon', 'photon sphere'],
      ['gm3', 'GM/c³ timescale'],
      ['tphys', 'disk T_max (physical)'],
      ['probeG', 'probe redshift g'],
      ['probeDil', 'probe dt/dτ'],
      ['probeR', 'probe radius'],
      ['probeT', 'probe τ vs t'],
    ];
    for (const [key, label] of FIELDS) {
      const cell = el('div', 'cell');
      const v = el('b', 'val', '—');
      cell.append(el('span', 'lbl', label), v);
      grid.append(cell);
      this.readouts[key] = v;
    }
    panel.append(grid);
    root.append(panel);

    // ---- bottom-centre: perf -------------------------------------------
    const perf = el('div', 'perf');
    this.fpsEl = el('b', 'fps', '60');
    perf.append(
      el('span', 'lbl', 'fps'),
      this.fpsEl,
      el('span', 'sep', '·'),
      ...this._kv('tier', 'tier'),
      ...this._kv('steps', 'steps'),
      ...this._kv('scale', 'render'),
      ...this._kv('fov', 'lens'),
      ...this._kv('mode', 'quality'),
    );
    root.append(perf);

    // ---- right: control panel ------------------------------------------
    const cp = el('div', 'panel');
    this.panelEl = cp;
    const head = el('div', 'panel-head');
    head.append(el('span', null, 'CONTROLS'));
    const collapse = el('button', 'icon-btn', '—');
    collapse.title = 'collapse panel';
    collapse.addEventListener('click', () => cp.classList.toggle('collapsed'));
    head.append(collapse);
    cp.append(head);

    const body = el('div', 'panel-body');

    // presets
    const preRow = el('div', 'preset-row');
    this.presetBtns = {};
    for (const key of PRESET_ORDER) {
      const b = el('button', 'preset', PRESETS[key].label);
      b.title = PRESETS[key].note;
      b.addEventListener('click', () => this.onPreset(key));
      preRow.append(b);
      this.presetBtns[key] = b;
    }
    body.append(el('div', 'section-label', 'presets'), preRow);
    this.presetNote = el('div', 'note', PRESETS.gargantua.note);
    body.append(this.presetNote);

    // sliders grouped
    const GROUPS = [
      ['gravity', 'gravity', ['mass', 'spin', 'lensing', 'timeScale']],
      ['disk', 'accretion disk', ['diskTemp', 'diskTilt', 'diskBrightness', 'photonRing']],
      ['sky', 'sky & optics', ['starDensity', 'alignStar', 'exposure', 'bloom', 'grain']],
    ];
    for (const [id, label, keys] of GROUPS) {
      const g = el('div', 'group');
      g.append(el('div', 'section-label', label));
      for (const key of keys) g.append(this._slider(key));
      body.append(g);
    }

    // toggles
    const tg = el('div', 'group');
    tg.append(el('div', 'section-label', 'layers'));
    const wrap = el('div', 'toggles');
    for (const key of ['showDisk', 'showStars', 'showGalaxy', 'showProbe']) {
      const lab = el('label', 'toggle');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(this.params[key]);
      input.addEventListener('change', () => this.onParam(key, input.checked));
      lab.append(input, el('span', null, PARAM_SPEC[key].label));
      wrap.append(lab);
      this.toggles[key] = input;
    }
    tg.append(wrap);
    body.append(tg);

    // actions
    const acts = el('div', 'group');
    acts.append(el('div', 'section-label', 'actions'));
    const rowA = el('div', 'btn-row');
    this.probeBtn = el('button', 'btn primary', 'DROP PROBE');
    this.probeBtn.title = 'release a probe from the ship (P)';
    this.probeBtn.addEventListener('click', () => this.onAction('probe'));
    this.flyBtn = el('button', 'btn', 'FLY IN');
    this.flyBtn.title = 'continuous thrust towards the horizon (F)';
    this.flyBtn.addEventListener('click', () => this.onAction('fly'));
    const stopBtn = el('button', 'btn', 'HOLD');
    stopBtn.title = 'cut thrust and hold station (space)';
    stopBtn.addEventListener('click', () => this.onAction('hold'));
    rowA.append(this.probeBtn, this.flyBtn, stopBtn);
    acts.append(rowA);

    const rowB = el('div', 'btn-row');
    this.cineBtn = el('button', 'btn wide', 'CINEMATIC MODE');
    this.cineBtn.title = 'slow scripted camera path for recording (C)';
    this.cineBtn.addEventListener('click', () => this.onAction('cinematic'));
    const resetBtn = el('button', 'btn', 'RESET VIEW');
    resetBtn.title = 'return to the opening shot (R)';
    resetBtn.addEventListener('click', () => this.onAction('reset'));
    rowB.append(this.cineBtn, resetBtn);
    acts.append(rowB);

    const qRow = el('div', 'btn-row');
    qRow.append(el('span', 'inline-label', 'quality'));
    const sel = document.createElement('select');
    sel.className = 'select';
    sel.append(new Option('auto (adapts to fps)', 'auto'));
    for (let i = 0; i < 5; i++) sel.append(new Option(`force tier ${i} — ${['ULTRA', 'HIGH', 'MEDIUM', 'LOW', 'MINIMAL'][i]}`, String(i)));
    sel.addEventListener('change', () => this.onAction('quality', sel.value));
    qRow.append(sel);
    acts.append(qRow);
    this.qualitySelect = sel;
    body.append(acts);

    // keys
    const keys = el('div', 'keys');
    keys.innerHTML =
      '<span>drag</span> orbit <span>wheel</span> zoom <span>shift+drag</span> thrust<br>' +
      '<span>W/S</span> fly in / out <span>A/D</span> orbit <span>P</span> probe <span>F</span> fly <span>C</span> cinematic <span>H</span> hud <span>R</span> reset';
    body.append(keys);

    cp.append(body);
    root.append(cp);

    // ---- cinematic progress --------------------------------------------
    const bar = el('div', 'cine-bar');
    this.cineFill = el('i');
    bar.append(this.cineFill);
    this.cineBar = bar;
    root.append(bar);

    // ---- cinematic exit --------------------------------------------------
    // The control panel fades out for recording (opacity 0 + pointer-events
    // none), so the button inside it cannot be clicked. This pill lives outside
    // the panel, stays visible and clickable, and says how to get out.
    const exit = el('button', 'cine-exit');
    exit.append(el('span', 'dot'), el('span', null, 'recording — click or press C / Esc to exit'));
    exit.type = 'button';
    exit.title = 'leave cinematic mode (C or Esc)';
    exit.addEventListener('click', () => this.onAction('cinematic'));
    this.cineExit = exit;
    root.append(exit);

    this.markPreset('gargantua');
  }

  _clock(label, cls) {
    const d = el('div', `clock ${cls}`);
    const v = el('b', 'mono', '00:00:00.000');
    d.append(el('span', 'lbl', label), v);
    d.valueEl = v;
    return d;
  }

  _kv(key, label) {
    const s = el('span', 'kv');
    const v = el('b', null, '—');
    s.append(el('span', 'lbl', label), v);
    this[key + 'El'] = v;
    return [s];
  }

  _slider(key) {
    const spec = PARAM_SPEC[key];
    const row = el('div', 'slider');
    const lab = el('span', 'lbl', spec.label);
    const val = el('b', 'val');
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '1000';
    input.step = '1';
    input.value = String(Math.round(sliderPosition(key, this.params[key]) * 1000));
    const apply = () => {
      const v = sliderValue(key, Number(input.value) / 1000);
      this.params[key] = v;
      val.textContent = spec.fmt(v);
      this.onParam(key, v);
    };
    input.addEventListener('input', apply);
    row.append(lab, val, input);
    this.sliders[key] = { input, val, spec };
    val.textContent = spec.fmt(this.params[key]);
    return row;
  }

  // -------------------------------------------------------------- public ---

  refresh() {
    for (const key of Object.keys(this.sliders)) {
      const s = this.sliders[key];
      s.input.value = String(Math.round(sliderPosition(key, this.params[key]) * 1000));
      s.val.textContent = s.spec.fmt(this.params[key]);
    }
    for (const key of Object.keys(this.toggles)) {
      this.toggles[key].checked = Boolean(this.params[key]);
    }
  }

  markPreset(name) {
    this.activePreset = name;
    for (const [k, b] of Object.entries(this.presetBtns)) b.classList.toggle('active', k === name);
    if (PRESETS[name]) this.presetNote.textContent = PRESETS[name].note;
  }

  setReadouts(d) {
    const now = performance.now();
    if (now - this._lastReadout < 90) return; // ~11 Hz is plenty for text
    this._lastReadout = now;
    const set = (key, text) => {
      const node = this.readouts[key];
      if (!node || this._readoutCache[key] === text) return;
      this._readoutCache[key] = text;
      node.textContent = text;
    };
    set('mass', d.massSolar < 1e5 ? d.massSolar.toFixed(2) : formatSci(d.massSolar));
    set('rs', formatDistanceKm(d.rsKm));
    set('rcam', `${d.rCam.toFixed(3)} r_s · ${formatDistanceKm(d.rCamKm)}`);
    set('isco', `${d.isco.toFixed(3)} r_s`);
    set('shadow', `${d.shadow.toFixed(3)} r_s`);
    set('photon', '1.500 r_s');
    set('gm3', `${d.gm3 < 1e-3 ? (d.gm3 * 1e6).toFixed(2) + ' µs' : d.gm3.toFixed(3)} s`);
    set('tphys', `${formatSci(d.tMax, 3)} K`);
    set('probeG', d.probe.active ? (d.probe.g < 0.01 ? formatSci(d.probe.g, 2) : d.probe.g.toFixed(4)) : '—');
    set('probeDil', d.probe.active ? (d.probe.dilation > 999 ? formatSci(d.probe.dilation, 2) : d.probe.dilation.toFixed(3)) : '—');
    set('probeR', d.probe.active ? `${d.probe.r.toFixed(4)} r_s${d.probe.frozen ? ' · frozen' : ''}` : '—');
    set('probeT', d.probe.active ? `τ ${formatClock(d.probe.tau * d.tScaleSec)} / t ${formatClock(d.probe.t * d.tScaleSec)}` : '—');

    this.clockShip.valueEl.textContent = formatClock(d.localClock);
    this.clockFar.valueEl.textContent = formatClock(d.distantClock);
    this.dilValue.textContent = d.dilation.toFixed(5);
    this.clockBox.classList.toggle('slow', d.dilation < 0.6);
    if (this.probeBtn) {
      // always actionable: clicking again releases a fresh probe. The status of
      // the running one lives in the telemetry panel, not in this label — an
      // informative-looking label that does nothing reads as a broken feature.
      this.probeBtn.classList.toggle('armed', !d.probe.active);
      this.probeBtn.textContent = d.probe.active ? 'DROP PROBE AGAIN' : 'DROP PROBE';
      this.probeBtn.title = d.probe.active
        ? `current probe: ${d.probe.r.toFixed(3)} r_s · g ${d.probe.g.toFixed(3)}${d.probe.frozen ? ' · frozen at horizon' : ''} — click to release another (P)`
        : 'release a probe from the ship (P)';
    }
  }

  setStats(s) {
    const fps = Math.round(s.fps);
    if (this.fpsEl.textContent !== String(fps)) this.fpsEl.textContent = String(fps);
    this.fpsEl.classList.toggle('bad', s.fps < 50);
    this.tierEl.textContent = s.tier;
    this.stepsEl.textContent = String(s.steps);
    this.scaleEl.textContent = `${Math.round(s.renderScale * 100)}%`;
    if (this.fovEl) {
      const wide = s.widen > 1.02;
      this.fovEl.textContent = `${Math.round(s.fov)}°${wide ? ' wide' : ''}${s.lookAway > 1 ? ' pan' : ''}`;
      this.fovEl.classList.toggle('bad', wide);
    }
    this.modeEl.textContent = s.auto ? 'auto' : 'locked';
    if (this.cineFill) this.cineFill.style.width = `${(s.cinematicProgress * 100).toFixed(2)}%`;
  }

  setCinematic(on) {
    this.cinematic = on;
    this.root.classList.toggle('cinematic', on);
    if (this.cineExit) this.cineExit.setAttribute('aria-hidden', on ? 'false' : 'true');
    this.panelEl.classList.toggle('hidden', on);
    this.cineBtn.classList.toggle('active', on);
    this.cineBtn.textContent = on ? 'EXIT CINEMATIC' : 'CINEMATIC MODE';
  }

  toggleHud() {
    this.hudHidden = !this.hudHidden;
    this.root.classList.toggle('hud-hidden', this.hudHidden);
    return this.hudHidden;
  }

  setFlyArmed(on) {
    this.flyBtn.classList.toggle('active', on);
    this.flyBtn.textContent = on ? 'THRUSTING' : 'FLY IN';
  }

  toast(msg, ms = 2600) {
    let t = this.root.querySelector('.toast');
    if (!t) {
      t = el('div', 'toast');
      this.root.append(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }
}
