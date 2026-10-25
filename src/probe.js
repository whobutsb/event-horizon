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
    // The blob is integrated analytically (closest approach per segment), so it
    // always draws no matter how coarse the march is -> this can stay small and
    // read as an object: ~15 px at release, ~7 px once it is down by the shadow.
    this.size = 0.06;
    this.flash = 0; // release flare, decays over ~0.6 s of sim time
    this.g = 1;
    this.dilation = 1;
    this.frozen = false;
    this.crossedDisk = 0;
    this._sub = 8;
  }

  /**
   * Deploy the probe just ahead of the ship and release it from rest.
   *
   * Geometry matters for legibility. Releasing it at the ship's own radius puts
   * it beside the camera (nearly zero depth, so a huge screen angle) and outside
   * the field of view. So we release it from about half the ship's radius — i.e.
   * clearly between you and the hole — tilted ~6 deg off the ship->hole axis,
   * mostly screen-vertical. It then appears next to the shadow and drifts in
   * towards it: a fixed angular offset subtends a smaller screen angle as r
   * shrinks, so the fall reads as a descent into the black disc.
   */
  drop({ camPos, camUp = new THREE.Vector3(0, 1, 0), camRight = null, rObs }) {
    const R = clamp(camPos.length(), 2.4, 34);
    const r0 = Math.max(3.2, Math.min(R * 0.55, R - 1.2));
    const base = camPos.clone().normalize(); // hole -> ship
    const up = camUp.clone().normalize();
    const right = (camRight ? camRight.clone() : new THREE.Vector3(1, 0, 0)).normalize();
    const off = up
      .multiplyScalar(0.92)
      .add(right.multiplyScalar(0.3))
      .normalize()
      .multiplyScalar(Math.tan((6 * Math.PI) / 180));
    this.dir = base.add(off).normalize();
    this.r0 = r0;
    // released from rest at r0 (with an imperceptible inward nudge: exactly at
    // rest is an unstable fixed point of the energy equation)
    this.state = infallStartState(r0, 2e-3);
    this.pos.copy(this.dir).multiplyScalar(r0);
    this.active = true;
    this.frozen = false;
    this.crossedDisk = 0;
    this.alpha = 1;
    this.flash = 1; // brief bright flare so the eye can find it
    this.stretch = 1;
    this.sync(rObs);
    return this;
  }

  /** Integrate `dtSim` of coordinate time (units of r_s/c). */
  update(dtSim, rObs) {
    if (!this.active) return this;
    const dt = clamp(dtSim, 0, 0.25);
    this.flash = Math.max(0, this.flash - dt * 1.7);
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
    // floor keeps it findable against the disk; the flare only lasts a moment
    this.alpha = clamp((0.3 + 1.15 * boost) * (1 + 2.4 * this.flash), 0, 2.2);

    // tidal stretch: radial elongation grows without bound near the horizon
    const proximity = clamp(1 - (this.state.r - 1) / (this.r0 - 1 + 1e-6), 0, 1);
    this.stretch = clamp(1 + 26 * Math.pow(proximity, 5.5) + 0.35 * (this.r0 / this.state.r - 1), 1, 44);
    // constant physical size (~10 px at a typical viewing distance); the tidal
    // stretch term is what makes it long, not this number
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
