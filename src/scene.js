/**
 * scene.js — renderer, render graph, per-frame uniform sync, clocks and the
 * automatic quality governor.
 *
 * Frame graph (all hand-rolled, all procedural):
 *
 *   raymarch (blackHole.frag) -> HDR target (RGBA16F)
 *        ├─ bright pass  -> A (w/2)      ┐ separable gaussian
 *        │                                ├-> bloomA
 *        │  blur H -> B, blur V -> A      ┘
 *        ├─ downsample   -> C (w/4)
 *        │  blur H -> D, blur V -> C   -> bloomB (wide)
 *        └─ composite: bloom + ACES + streaks + chroma + vignette + grain -> canvas
 */

import * as THREE from 'three';
import {
  createBlackHoleMaterial,
  createBlackHoleUniforms,
  createBrightMaterial,
  createBlurMaterial,
  createCompositeMaterial,
  createDownsampleMaterial,
} from './shaders/index.js';
import { clamp, deriveTimeStretch, timeDilationFactorRs } from './physics.js';
import { deriveScene } from './presets.js';

/** Quality ladder. The governor walks down it when fps < 50, up when it is safe. */
export const QUALITY_TIERS = [
  { name: 'ULTRA', scale: 1.0, steps: 236, bloomLevels: 2, chroma: 0.75 },
  { name: 'HIGH', scale: 0.86, steps: 184, bloomLevels: 2, chroma: 0.6 },
  { name: 'MEDIUM', scale: 0.72, steps: 138, bloomLevels: 1, chroma: 0.45 },
  { name: 'LOW', scale: 0.6, steps: 104, chroma: 0.3, bloomLevels: 1 },
  { name: 'MINIMAL', scale: 0.48, steps: 74, bloomLevels: 1, chroma: 0.0 },
];

export const FPS_FLOOR = 50; // drop quality below this
export const FPS_HEADROOM = 58; // climb back above this

/**
 * Automatic quality scaling with hysteresis so the renderer never oscillates.
 */
export class QualityGovernor {
  constructor(tiers = QUALITY_TIERS) {
    this.tiers = tiers;
    this.index = Math.min(1, tiers.length - 1);
    this.auto = true;
    this.emaMs = 16.7;
    this.lastChange = -1e9;
    this.goodSince = 0;
    this.changes = 0;
  }

  get tier() {
    return this.tiers[this.index];
  }

  /** Feed one frame time (ms). Returns true when the tier changed. */
  sample(frameMs, nowSec) {
    // never let a glitched timing sample (NaN/Infinity from a tab switch or a
    // profiler pause) poison the moving average permanently
    const ms = Number.isFinite(frameMs) ? clamp(frameMs, 0.5, 500) : this.emaMs;
    this.emaMs = this.emaMs * 0.9 + ms * 0.1;
    if (!Number.isFinite(this.emaMs)) this.emaMs = 16.7;
    if (!this.auto) return false;
    const fps = 1000 / this.emaMs;
    let changed = false;

    if (fps < FPS_FLOOR && this.index < this.tiers.length - 1 && nowSec - this.lastChange > 1.1) {
      this.index++;
      changed = true;
    } else if (fps > FPS_HEADROOM) {
      if (!this.goodSince) this.goodSince = nowSec;
      if (nowSec - this.goodSince > 3.5 && this.index > 0 && nowSec - this.lastChange > 3.0) {
        this.index--;
        changed = true;
      }
    } else {
      this.goodSince = 0;
    }
    if (changed) {
      this.changes++;
      this.lastChange = nowSec;
      this.goodSince = 0;
      this.emaMs = 16.7; // give the new tier a clean measurement window
    }
    return changed;
  }

  setTier(i) {
    this.index = clamp(Math.round(i), 0, this.tiers.length - 1);
    this.auto = false;
    this.changes++;
    return this.tier;
  }
}

function makeTarget(w, h) {
  const t = new THREE.WebGLRenderTarget(Math.max(2, w | 0), Math.max(2, h | 0), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
  return t;
}

export class Simulator {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{params:object, rig:import('./camera.js').CameraRig, probe:import('./probe.js').Probe}} deps
   */
  constructor(canvas, { params, rig, probe }) {
    this.canvas = canvas;
    this.params = params;
    this.rig = rig;
    this.probe = probe;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: false,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.autoClear = true;

    this.governor = new QualityGovernor();
    this.basePixelRatio = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 1.5);

    // ---- render graph -----------------------------------------------------
    this.uniforms = createBlackHoleUniforms();
    this.bhMaterial = createBlackHoleMaterial(this.uniforms);
    this.brightMaterial = createBrightMaterial();
    this.blurMaterial = createBlurMaterial();
    this.downMaterial = createDownsampleMaterial();
    this.compositeMaterial = createCompositeMaterial();

    this.quadScene = new THREE.Scene();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bhMaterial);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    this.passCamera = new THREE.Camera();

    this.rtScene = makeTarget(2, 2);
    this.rtA = makeTarget(2, 2);
    this.rtB = makeTarget(2, 2);
    this.rtC = makeTarget(2, 2);
    this.rtD = makeTarget(2, 2);

    // ---- clocks -----------------------------------------------------------
    this.simT = 0; // coordinate time of the distant observer (r_s/c units)
    this.localT = 0; // proper time on the ship
    this.diskClock = 0; // noise evolution clock
    this.wallT = 0;
    this.dilation = 1;
    this.stretch = 0;

    // Alignment star: seeded straight behind the hole for the opening shot, then
    // it precesses slowly so Einstein rings bloom and fade by themselves.
    this.alignBase = rig.camera.position.clone().multiplyScalar(-1).normalize();
    if (!Number.isFinite(this.alignBase.lengthSq()) || this.alignBase.lengthSq() < 1e-9) {
      this.alignBase.set(0, 0.06, -1).normalize();
    }
    this.alignDir = this.alignBase.clone();

    this.width = 2;
    this.height = 2;
    this.stats = {
      fps: 60,
      frameMs: 16.7,
      tier: this.governor.tier.name,
      tierIndex: this.governor.index,
      steps: this.governor.tier.steps,
      renderScale: 1,
      pixels: 0,
      changes: 0,
    };

    this._v = new THREE.Vector3();
    this.contextLost = false;
    canvas.addEventListener?.('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    canvas.addEventListener?.('webglcontextrestored', () => {
      this.contextLost = false;
    });

    this.setParams(params);
  }

  // ------------------------------------------------------------- sizing ----

  setSize(cssW, cssH) {
    const scale = this.governor.tier.scale * this.basePixelRatio;
    this.cssWidth = Math.max(1, Math.floor(cssW));
    this.cssHeight = Math.max(1, Math.floor(cssH));
    const w = Math.max(2, Math.round(this.cssWidth * scale));
    const h = Math.max(2, Math.round(this.cssHeight * scale));
    this.pixelScale = scale;
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(scale);
    this.renderer.setSize(this.cssWidth, this.cssHeight, false);
    for (const t of [this.rtScene, this.rtA, this.rtB]) t.setSize(w, h);
    for (const t of [this.rtC, this.rtD]) t.setSize(Math.round(w / 2), Math.round(h / 2));
    this.uniforms.uResolution.value.set(w, h);
    this.compositeMaterial.uniforms.uResolution.value.set(w, h);
    this.stats.renderScale = scale;
    this.stats.pixels = w * h;
    return this;
  }

  setParams(params) {
    this.params = params;
    const d = deriveScene(params);
    this.derived = d;
    this.uniforms.uDiskInner.value = d.diskInner;
    this.uniforms.uDiskOuter.value = d.diskOuter;
    return this;
  }

  /** Re-run the sizing maths after the governor moved to another tier. */
  applyTier() {
    this.setSize(this.cssWidth, this.cssHeight);
    this.stats.tier = this.governor.tier.name;
    this.stats.steps = this.governor.tier.steps;
  }

  // --------------------------------------------------------------- frame ---

  /**
   * Advance the simulation and draw one frame.
   * @param {number} dtWall seconds since last frame (real time)
   */
  frame(dtWall) {
    const p = this.params;
    const dt = clamp(dtWall, 0, 0.1);
    this.wallT += dt;

    // ---- clocks ----------------------------------------------------------
    const simDt = dt * p.timeScale;
    this.simT += simDt;
    this.rig.update(dt);
    const rCam = Math.max(this.rig.radius, 1.0001);
    this.dilation = timeDilationFactorRs(rCam); // dtau/dt on the ship
    this.localT += simDt * this.dilation;
    this.diskClock += simDt * this.derived.diskFlowRate;
    this.stretch = deriveTimeStretch(this.dilation);

    // ---- probe -----------------------------------------------------------
    if (this.probe.active) this.probe.update(simDt, rCam);

    // ---- raymarch uniforms ----------------------------------------------
    const u = this.uniforms;
    const b = this.rig.basis();
    u.uTime.value = this.diskClock;
    u.uCamPos.value.copy(b.pos);
    u.uCamFwd.value.copy(b.fwd);
    u.uCamRight.value.copy(b.right);
    u.uCamUp.value.copy(b.up);
    u.uTanHalfFov.value = Math.tan(((this.rig.effectiveFov ?? this.rig.fov) * Math.PI) / 360);
    u.uAspect.value = this.cssWidth / Math.max(1, this.cssHeight);
    u.uTilt.value = (p.diskTilt * Math.PI) / 180;
    u.uLens.value = p.lensing;
    u.uSteps.value = this.governor.tier.steps;
    u.uDiskTemp.value = p.diskTemp;
    u.uDiskBright.value = p.diskBrightness;
    u.uDiskOpacity.value = clamp(0.16 + 0.2 * p.diskBrightness, 0.08, 0.5);
    u.uShowDisk.value = p.showDisk ? 1 : 0;
    u.uPhotonRing.value = p.photonRing;
    u.uStars.value = p.showStars ? 1 : 0;
    u.uStarDensity.value = p.starDensity;
    u.uGalaxyOn.value = p.showGalaxy ? 1 : 0;
    u.uAlignMag.value = p.alignStar;
    // the alignment star drifts across the sky so it periodically lines up with
    // the hole and flashes a full Einstein ring
    const ay = 0.5 * Math.sin(this.simT * 0.032);
    const ax = 0.14 * Math.sin(this.simT * 0.021 + 1.1);
    this.alignDir
      .copy(this.alignBase)
      .applyAxisAngle(this._v.set(0, 1, 0), ay)
      .applyAxisAngle(this._v.set(1, 0, 0), ax);
    u.uAlignDir.value.copy(this.alignDir);
    u.uCamDilation.value = Math.max(this.dilation, 0.06);

    if (p.showProbe && this.probe.active) {
      u.uShowProbe.value = 1;
      u.uProbePos.value.copy(this.probe.pos);
      u.uProbeColor.value.copy(this.probe.color);
      u.uProbeStretch.value = this.probe.stretch;
      u.uProbeAlpha.value = this.probe.alpha;
      u.uProbeSize.value = this.probe.size;
    } else {
      u.uProbeAlpha.value = 0;
    }

    // ---- pass 1: raymarch into HDR --------------------------------------
    const tier = this.governor.tier;
    this.quad.material = this.bhMaterial;
    this.renderer.setRenderTarget(this.rtScene);
    this.renderer.render(this.quadScene, this.passCamera);

    // ---- pass 2: bright + bloom pyramid ---------------------------------
    const bu = this.brightMaterial.uniforms;
    bu.tSrc.value = this.rtScene.texture;
    bu.uTexel.value.set(1 / this.width, 1 / this.height);
    bu.uThreshold.value = 3.0;
    bu.uKnee.value = 1.2;
    this.quad.material = this.brightMaterial;
    this.renderer.setRenderTarget(this.rtA);
    this.renderer.render(this.quadScene, this.passCamera);

    const blur = (src, dst, dx, dy) => {
      const mu2 = this.blurMaterial.uniforms;
      mu2.tSrc.value = src.texture;
      mu2.uDirection.value.set(dx, dy);
      this.quad.material = this.blurMaterial;
      this.renderer.setRenderTarget(dst);
      this.renderer.render(this.quadScene, this.passCamera);
    };

    const txA = 0.95 / this.width;
    const tyA = 0.95 / this.height;
    blur(this.rtA, this.rtB, txA, 0);
    blur(this.rtB, this.rtA, 0, tyA);

    let bloomBWeight = 0;
    if (tier.bloomLevels > 1) {
      const du = this.downMaterial.uniforms;
      du.tSrc.value = this.rtA.texture;
      du.uTexel.value.set(2 / this.width, 2 / this.height);
      this.quad.material = this.downMaterial;
      this.renderer.setRenderTarget(this.rtC);
      this.renderer.render(this.quadScene, this.passCamera);
      const w4 = this.rtC.width;
      const h4 = this.rtC.height;
      blur(this.rtC, this.rtD, 3.1 / w4, 0);
      blur(this.rtD, this.rtC, 0, 3.1 / h4);
      bloomBWeight = 1;
    }

    // ---- pass 3: composite ----------------------------------------------
    const cu = this.compositeMaterial.uniforms;
    cu.tScene.value = this.rtScene.texture;
    cu.tBloomA.value = this.rtA.texture;
    cu.tBloomB.value = this.rtC.texture;
    cu.uBloomBWeight.value = bloomBWeight;
    cu.uAspect.value = this.cssWidth / Math.max(1, this.cssHeight);
    cu.uExposure.value = p.exposure;
    cu.uBloomStrength.value = p.bloom;
    cu.uGrain.value = p.grain;
    cu.uTime.value = this.wallT;
    cu.uStretch.value = this.stretch;
    cu.uChroma.value = tier.chroma;
    const pose = this.rig.shadowScreenPose(cu.uAspect.value);
    cu.uShadowCenter.value.set(pose.cx, pose.cy);
    cu.uShadowRadius.value = clamp(pose.radius, 0.004, 1.6);
    this.quad.material = this.compositeMaterial;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.passCamera);

    return this;
  }

  /** Feed the frame time to the governor; may resize the render targets. */
  govern(frameMs) {
    this.stats.frameMs = this.governor.emaMs;
    this.stats.fps = 1000 / Math.max(this.governor.emaMs, 0.001);
    const now = this.wallT;
    if (this.governor.sample(frameMs, now)) {
      this.applyTier();
    }
    this.stats.tier = this.governor.tier.name;
    this.stats.steps = this.governor.tier.steps;
    this.stats.changes = this.governor.changes;
    this.stats.auto = this.governor.auto;
    return this.stats;
  }

  dispose() {
    for (const t of [this.rtScene, this.rtA, this.rtB, this.rtC, this.rtD]) t.dispose();
    for (const m of [this.bhMaterial, this.brightMaterial, this.blurMaterial, this.downMaterial, this.compositeMaterial]) {
      m.dispose();
    }
    this.quad.geometry.dispose();
    this.renderer.dispose();
  }
}
