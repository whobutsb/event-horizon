/**
 * probe.js — the dropped probe.
 *
 * A point-like ship released from rest at the moment you press DROP and then in
 * free fall along a radial geodesic. Its radius is integrated in *coordinate*
 * time, which is exactly why it freezes on the screen: dr/dt = 0 at the horizon.
 * Colour, dimming and tidal stretching are derived from the same redshift
 * factor the HUD prints (physics.probeRedshift).
 */

import * as THREE from 'three';
import {
  clamp,
  infallDrDt,
  infallStartState,
  probeRedshift,
  probeTimeDilation,
  stepProbe,
} from './physics.js';

/** Colour of a blackbody at `kelvin` (JS twin of the GLSL helper's intent). */
function kelvinToRgb(kelvin) {
  const t = clamp(kelvin, 1000, 40000) / 100;
  let r, g, b;
  if (t < 66) r = 1;
  else r = 1.292936 * Math.pow(Math.max(t - 60, 0.08), -0.1332047592);
  if (t < 66) g = 0.3900816 * Math.log(t) - 0.6318414;
  else g = 1.129891 * Math.pow(Math.max(t - 60, 0.08), -0.0755148492);
  if (t > 66) b = 1;
  else if (t < 19) b = 0;
  else b = 0.5432068 * Math.log(t - 10) - 1.196254;
  const c = new THREE.Color(clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1));
  c.r **= 2.2;
  c.g **= 2.2;
  c.b **= 2.2;
  const m = Math.max(c.r, c.g, c.b, 1e-6);
  return c.multiplyScalar(1 / m);
}

export class Probe {
  constructor() {
    this.active = false;
    this.dir = new THREE.Vector3(1, 0, 0); // unit radial direction of the fall
    this.r0 = 8; // release radius in r_s
    this.state = { r: 8, t: 0, tau: 0 };
    this.pos = new THREE.Vector3();
    this.color = new THREE.Color(1, 1, 1);
    this.stretch = 1;
    this.alpha = 0;
    this.size = 0.05;
    this.g = 1;
    this.dilation = 1;
    this.frozen = false;
    this.crossedDisk = 0;
    this._sub = 8;
  }

  /**
   * Release the probe near the ship.
   * @param {{camPos:THREE.Vector3, camUp:THREE.Vector3, rObs:number}} ctx
   */
  drop({ camPos, camUp = new THREE.Vector3(0, 1, 0), rObs }) {
    const r0 = clamp(camPos.length(), 2.4, 34);
    // start slightly off the camera-hole axis so the fall stays visible next to
    // the shadow instead of disappearing straight behind it
    const base = camPos.clone().normalize();
    const side = new THREE.Vector3()
      .crossVectors(base, camUp)
      .normalize()
      .addScaledVector(camUp, 0.55);
    if (!Number.isFinite(side.lengthSq()) || side.lengthSq() < 1e-6) side.set(0, 0.4, 0);
    this.dir = base.add(side.multiplyScalar(0.22)).normalize();
    this.r0 = r0;
    // released from rest at r0 (with an imperceptible inward nudge: exactly at
    // rest is an unstable fixed point of the energy equation)
    this.state = infallStartState(r0, 2e-3);
    this.pos.copy(this.dir).multiplyScalar(r0);
    this.active = true;
    this.frozen = false;
    this.crossedDisk = 0;
    this.alpha = 1;
    this.stretch = 1;
    this.sync(rObs);
    return this;
  }

  /** Integrate `dtSim` of coordinate time (units of r_s/c). */
  update(dtSim, rObs) {
    if (!this.active) return this;
    const dt = clamp(dtSim, 0, 0.25);
    const h = dt / this._sub;
    for (let i = 0; i < this._sub; i++) {
      if (this.state.r <= 1.0008) break;
      this.state = stepProbe(this.state, h, this.r0);
    }
    this.pos.copy(this.dir).multiplyScalar(this.state.r);
    this.sync(rObs);
    if (this.state.r <= 1.0012) this.frozen = true;
    return this;
  }

  /** Push derived quantities into the uniforms-facing fields. */
  sync(rObs) {
    const r = this.state.r;
    // observed redshift: nu_obs / nu_emit (-> 0 at the horizon)
    this.g = probeRedshift(r, this.r0, 1, Math.max(rObs, 1.0001));
    this.dilation = probeTimeDilation(r, this.r0, 1);

    // the ship is a ~6500 K emitter; the shift drags it through orange into the
    // infrared while g^3 beaming dims it
    const observedTemp = 6500 * Math.max(this.g, 1e-4);
    this.color.copy(kelvinToRgb(observedTemp));
    const boost = Math.pow(clamp(this.g, 0, 2), 1.15);
    this.alpha = clamp(0.12 + 1.05 * boost, 0, 1.15);

    // tidal stretch: radial elongation grows without bound near the horizon
    const proximity = clamp(1 - (this.state.r - 1) / (this.r0 - 1 + 1e-6), 0, 1);
    this.stretch = clamp(1 + 26 * Math.pow(proximity, 5.5) + 0.35 * (this.r0 / this.state.r - 1), 1, 44);
    // small enough to read as an object; the tidal term does the growing
    this.size = 0.05;
    return this;
  }

  /** Readout bundle for the HUD. */
  readout() {
    return {
      active: this.active,
      r: this.state.r,
      r0: this.r0,
      t: this.state.t,
      tau: this.state.tau,
      g: this.g,
      dilation: this.dilation,
      drdt: infallDrDt(this.state.r, this.r0, 1),
      stretch: this.stretch,
      frozen: this.frozen,
    };
  }

  reset() {
    this.active = false;
    this.alpha = 0;
    this.frozen = false;
    return this;
  }
}
