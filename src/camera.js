/**
 * camera.js — camera rig: orbit, damped zoom, powered fly-in towards the
 * horizon, and a scripted cinematic path for recording.
 *
 * Everything is expressed in units of the Schwarzschild radius, because that is
 * the unit the raymarcher works in. The rig never lets you cross the horizon.
 */

import * as THREE from 'three';
import { clamp, lerp, SHADOW_RADIUS_RS, smoothstep } from './physics.js';

/**
 * How much wider the lens opens as you approach the hole.
 *
 * Inside ~2.7 r_s the shadow is physically wider than a normal field of view:
 * every ray in front of you ends up on the horizon, so a 50-degree lens renders
 * a completely black frame. Opening the lens (dolly-zoom style) keeps the
 * silhouette in shot and shows the outside universe squeezed to the edges,
 * which is what a real infalling observer would see.
 */
export function fovWidenFactor(radiusRs) {
  const r = Number.isFinite(radiusRs) ? radiusRs : 100;
  return 1 + 1.35 * (1 - smoothstep(1.3, 4.6, r));
}

/** Half-angle of the shadow on screen for a camera at `rRs` (radians). */
export function shadowAngularRadius(rRs) {
  const r = Math.max(Number.isFinite(rRs) ? rRs : 100, 1.0001);
  return Math.asin(clamp(SHADOW_RADIUS_RS / r, 0, 0.9995));
}

/**
 * How far the camera automatically swings away from staring straight into the
 * hole, in radians, as a function of radius.
 *
 * Inside ~1.5 r_s the shadow is not a disk in front of you any more: it is every
 * direction except a cone around "outwards". Without swinging the view the
 * screen would simply go black, so the rig pans sideways (never past 78 degrees,
 * so the silhouette always stays in shot).
 */
export function lookAwayAngle(radiusRs) {
  const r = Number.isFinite(radiusRs) ? radiusRs : 100;
  return (52 * Math.PI) / 180 * (1 - smoothstep(1.4, 2.9, r));
}

export const MIN_RADIUS = 1.045; // r_s — you can get close, but never through
export const MAX_RADIUS = 42;

/** The scripted cinematic path. Loops seamlessly (last key === first key). */
export const CINEMATIC_KEYS = [
  { t: 0, radius: 30, theta: -1.25, phi: 1.46, fov: 38 },
  { t: 13, radius: 11, theta: 0.85, phi: 1.49, fov: 50 },
  { t: 25, radius: 6.4, theta: 2.45, phi: 0.7, fov: 58 },
  { t: 37, radius: 3.1, theta: 3.95, phi: 1.28, fov: 66 },
  { t: 48, radius: 1.5, theta: 4.62, phi: 1.5, fov: 74 },
  { t: 60, radius: 17, theta: 5.85, phi: 1.2, fov: 46 },
  { t: 72, radius: 30, theta: 5.03 + Math.PI * 2, phi: 1.46, fov: 38 },
];

export const CINEMATIC_DURATION = CINEMATIC_KEYS[CINEMATIC_KEYS.length - 1].t;

/** Sample the scripted path at time `time` (seconds, loops). */
export function sampleCinematic(time, keys = CINEMATIC_KEYS) {
  const dur = keys[keys.length - 1].t;
  const t = ((time % dur) + dur) % dur;
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].t <= t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const u = smoothstep(a.t, b.t, t);
  // ease in/out of each leg so the camera never snaps
  const e = u * u * (3 - 2 * u);
  return {
    radius: lerp(a.radius, b.radius, e),
    theta: lerp(a.theta, b.theta, e),
    phi: lerp(a.phi, b.phi, e),
    fov: lerp(a.fov, b.fov, e),
    leg: i,
    legT: u,
  };
}

export class CameraRig {
  constructor(opts = {}) {
    this.camera = new THREE.PerspectiveCamera(opts.fov ?? 52, 1, 0.01, 600);
    this.radius = opts.radius ?? 13;
    this.theta = opts.theta ?? -0.75; // azimuth
    this.phi = opts.phi ?? 1.42; // polar from +Y (1.57 = edge-on)
    this.targetRadius = this.radius;
    this.targetTheta = this.theta;
    this.targetPhi = this.phi;
    this.fov = opts.fov ?? 52;
    this.targetFov = this.fov;
    this.damping = opts.damping ?? 6.5;
    this.thrust = 0; // -1 = fly out, +1 = fly in
    this.cinematic = false;
    this.cinematicTime = 0;
    this.userInputLocked = false;
    this.widen = 1;
    this.effectiveFov = opts.fov ?? 52;
    this.lookAway = 0; // radians the view is panned off the hole
    this._pos = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this._radial = new THREE.Vector3();
    this._tangent = new THREE.Vector3();
  }

  // ------------------------------------------------------------ input -----

  orbit(dx, dy) {
    if (this.userInputLocked) return;
    const k = 0.0052;
    this.targetTheta -= dx * k;
    this.targetPhi = clamp(this.targetPhi - dy * k, 0.08, Math.PI - 0.08);
  }

  /** wheel / pinch: positive `delta` zooms out. */
  zoom(delta) {
    if (this.userInputLocked) return;
    this.targetRadius = clamp(this.targetRadius * Math.exp(delta * 0.0013), MIN_RADIUS, MAX_RADIUS);
  }

  /** -1 fly out, +1 fly in towards the horizon, 0 hover. */
  setThrust(dir) {
    if (this.userInputLocked) return;
    this.thrust = clamp(dir, -1, 1);
  }

  goTo({ radius, theta, phi, fov } = {}) {
    if (radius !== undefined) this.targetRadius = clamp(radius, MIN_RADIUS, MAX_RADIUS);
    if (theta !== undefined) this.targetTheta = theta;
    if (phi !== undefined) this.targetPhi = clamp(phi, 0.08, Math.PI - 0.08);
    if (fov !== undefined) this.targetFov = clamp(fov, 12, 100);
  }

  /** Blend time (s) used to ease the current pose into the scripted path. */
  blendDuration = 2.4;

  startCinematic() {
    this.cinematic = true;
    this.userInputLocked = true;
    this.thrust = 0;
    // ease from wherever the ship currently is instead of jump-cutting to key 0
    this._blendFrom = {
      radius: this.radius,
      theta: this.theta,
      phi: this.phi,
      fov: this.fov,
    };
    this.cinematicTime = 0;
  }

  stopCinematic() {
    this.cinematic = false;
    this.userInputLocked = false;
    // keep the current pose as the new target so nothing jumps
    this.targetRadius = this.radius;
    this.targetTheta = this.theta;
    this.targetPhi = this.phi;
    this.targetFov = this.fov;
  }

  get cinematicProgress() {
    return (this.cinematicTime % CINEMATIC_DURATION) / CINEMATIC_DURATION;
  }

  // ------------------------------------------------------------ update ----

  update(dt) {
    const d = Math.min(dt, 0.1);
    if (this.cinematic) {
      this.cinematicTime += d;
      const k = sampleCinematic(this.cinematicTime);
      // ease into the scripted path over the first couple of seconds
      let w = 1;
      if (this._blendFrom) {
        const b = this._blendFrom;
        w = Math.min(1, this.cinematicTime / Math.max(this.blendDuration, 1e-3));
        w = w * w * (3 - 2 * w);
        this.radius = b.radius + (k.radius - b.radius) * w;
        this.theta = b.theta + (k.theta - b.theta) * w;
        this.phi = b.phi + (k.phi - b.phi) * w;
        this.fov = b.fov + (k.fov - b.fov) * w;
        if (w >= 1) this._blendFrom = null;
      } else {
        this.radius = k.radius;
        this.theta = k.theta;
        this.phi = k.phi;
        this.fov = k.fov;
      }
      this.targetRadius = k.radius;
      this.targetTheta = k.theta;
      this.targetPhi = k.phi;
      this.targetFov = k.fov;
    } else {
      if (this.thrust !== 0) {
        // exponential approach: feels like a slow, controlled spiral
        this.targetRadius = clamp(
          this.targetRadius * Math.exp(-this.thrust * d * 0.42),
          MIN_RADIUS,
          MAX_RADIUS,
        );
      }
      const a = 1 - Math.exp(-this.damping * d);
      this.radius += (this.targetRadius - this.radius) * a;
      this.theta += (this.targetTheta - this.theta) * a;
      this.phi += (this.targetPhi - this.phi) * a;
      const fa = 1 - Math.exp(-4.0 * d);
      this.fov += (this.targetFov - this.fov) * fa;
    }

    const sp = Math.sin(this.phi);
    this._pos.set(
      this.radius * sp * Math.sin(this.theta),
      this.radius * Math.cos(this.phi),
      this.radius * sp * Math.cos(this.theta),
    );
    this.camera.position.copy(this._pos);

    // Look at the hole — unless we are so close that "at the hole" means "all
    // black", in which case pan sideways so the outside universe stays in frame.
    this.lookAway = lookAwayAngle(this.radius);
    this._radial.copy(this._pos).normalize();
    this._tangent
      .set(Math.cos(this.phi) * Math.sin(this.theta), -Math.sin(this.phi), Math.cos(this.phi) * Math.cos(this.theta))
      .normalize();
    const a = this.lookAway;
    this._v
      .copy(this._radial)
      .multiplyScalar(-Math.cos(a))
      .addScaledVector(this._tangent, Math.sin(a))
      .normalize();
    if (Math.abs(this._v.y) > 0.95) this.camera.up.copy(this._radial);
    else this.camera.up.set(0, 1, 0);
    this.camera.lookAt(
      this._pos.x + this._v.x,
      this._pos.y + this._v.y,
      this._pos.z + this._v.z,
    );

    // open the lens as the shadow grows past a normal field of view
    this.widen = fovWidenFactor(this.radius);
    const eff = clamp(this.fov * this.widen, 12, 124);
    this.effectiveFov = eff;
    if (Math.abs(this.camera.fov - eff) > 1e-3) {
      this.camera.fov = eff;
      this.camera.updateProjectionMatrix();
    }
    return this;
  }

  /** Orthonormal basis for the raymarcher (world frame, r_s units). */
  basis() {
    this._v.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this._fwd.copy(this._v).normalize();
    this._right.set(1, 0, 0).applyQuaternion(this.camera.quaternion).normalize();
    this._up.set(0, 1, 0).applyQuaternion(this.camera.quaternion).normalize();
    return { pos: this.camera.position, fwd: this._fwd, right: this._right, up: this._up };
  }

  /**
   * Where the shadow lands on screen, for the star-streak post effect.
   * @returns {{cx:number, cy:number, radius:number}} in uv units (y-normalised)
   */
  shadowScreenPose(aspect) {
    // be correct even when called outside a render pass
    this.camera.updateMatrixWorld();
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    this._v.set(0, 0, 0).project(this.camera);
    const halfTan = Math.tan(((this.effectiveFov ?? this.fov) * Math.PI) / 360);
    const d = Math.max(this.radius, 1.0001);
    // apparent angular radius of the shadow: b_crit = 2.598 r_s at distance d
    const ang = Math.asin(clamp(SHADOW_RADIUS_RS / d, 0, 0.999));
    const uvRadius = (Math.tan(ang) / halfTan) * 0.5;
    return {
      cx: this._v.x * 0.5 + 0.5,
      cy: this._v.y * 0.5 + 0.5,
      radius: uvRadius,
    };
  }
}

/**
 * Wire pointer + wheel input on a DOM element.
 * drag = orbit · wheel/pinch = zoom · shift-drag or right-drag = fly in/out
 */
export function attachCameraInput(rig, dom) {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let flying = false;

  const down = (e) => {
    dom.setPointerCapture?.(e.pointerId);
    dragging = true;
    flying = e.shiftKey || e.button === 2 || e.button === 1;
    lastX = e.clientX;
    lastY = e.clientY;
    if (flying) rig.setThrust(e.clientY > window.innerHeight * 0.5 ? 1 : -1);
  };
  const move = (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    if (flying) {
      rig.setThrust(dy > 0 ? 1 : -1);
    } else {
      rig.orbit(dx, dy);
    }
  };
  const up = () => {
    dragging = false;
    flying = false;
    rig.setThrust(0);
  };

  dom.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  dom.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      rig.zoom(e.deltaY);
    },
    { passive: false },
  );
  dom.addEventListener('contextmenu', (e) => e.preventDefault());

  return () => {
    dom.removeEventListener('pointerdown', down);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    rig.setThrust(0);
  };
}
