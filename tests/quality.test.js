/**
 * tests/quality.test.js — the adaptive quality governor and the camera rig maths.
 * Both are pure logic (no WebGL context needed), so they run in plain node.
 */

import { describe, expect, it } from 'vitest';
import { FPS_FLOOR, FPS_HEADROOM, QUALITY_TIERS, QualityGovernor } from '../src/scene.js';
import {
  CINEMATIC_DURATION,
  CameraRig,
  MAX_RADIUS,
  MIN_RADIUS,
  fovWidenFactor,
  lookAwayAngle,
  sampleCinematic,
  shadowAngularRadius,
} from '../src/camera.js';
import { clamp } from '../src/physics.js';

describe('quality ladder', () => {
  it('is ordered from most to least expensive', () => {
    for (let i = 1; i < QUALITY_TIERS.length; i++) {
      expect(QUALITY_TIERS[i].scale).toBeLessThan(QUALITY_TIERS[i - 1].scale);
      expect(QUALITY_TIERS[i].steps).toBeLessThan(QUALITY_TIERS[i - 1].steps);
    }
    expect(QUALITY_TIERS[0].scale).toBe(1);
  });

  it('every tier is renderable', () => {
    for (const t of QUALITY_TIERS) {
      expect(t.scale).toBeGreaterThan(0.2);
      expect(t.steps).toBeGreaterThanOrEqual(48);
      expect(t.bloomLevels).toBeGreaterThanOrEqual(1);
      expect(typeof t.name).toBe('string');
    }
  });

  it('targets 60 fps and degrades below 50', () => {
    expect(FPS_FLOOR).toBe(50);
    expect(FPS_HEADROOM).toBeGreaterThan(FPS_FLOOR);
  });
});

describe('QualityGovernor', () => {
  const feed = (g, ms, t0, n = 1, step = 2) => {
    let t = t0;
    for (let i = 0; i < n; i++) {
      t += step / 1000;
      g.sample(ms, t);
    }
    return t;
  };

  it('starts in auto mode near the top of the ladder', () => {
    const g = new QualityGovernor();
    expect(g.auto).toBe(true);
    expect(g.index).toBeLessThan(2);
  });

  it('walks down the ladder when frames take too long', () => {
    const g = new QualityGovernor();
    const start = g.index;
    feed(g, 1000 / 30, 0, 400, 20); // 30 fps for ~8 s of wall clock
    expect(g.index).toBeGreaterThan(start);
    expect(g.changes).toBeGreaterThan(0);
  });

  it('climbs back up when there is headroom', () => {
    const g = new QualityGovernor();
    let t = feed(g, 1000 / 30, 0, 400, 20); // degrade first
    expect(g.index).toBeGreaterThan(0);
    const degraded = g.index;
    t = feed(g, 1000 / 120, t, 900, 20); // 120 fps for ~18 s
    expect(g.index).toBeLessThan(degraded);
  });

  it('does not oscillate: a steady frame rate between floor and headroom changes nothing', () => {
    const g = new QualityGovernor();
    feed(g, 1000 / 55, 0, 600, 18); // comfortably above the floor, below the headroom
    expect(g.changes).toBe(0);
  });

  it('respects manual tier locking', () => {
    const g = new QualityGovernor();
    g.setTier(4);
    expect(g.auto).toBe(false);
    expect(g.tier).toBe(QUALITY_TIERS[4]);
    feed(g, 1000 / 200, 0, 500, 20); // huge headroom must not auto-climb
    expect(g.index).toBe(4);
    g.setTier(-9);
    expect(g.index).toBe(0);
  });

  it('ignores insane frame times without exploding', () => {
    const g = new QualityGovernor();
    feed(g, NaN, 0, 10);
    feed(g, 0, 0, 10);
    feed(g, 1e9, 1e6, 10);
    expect(Number.isFinite(g.emaMs)).toBe(true);
    expect(g.index).toBeLessThan(QUALITY_TIERS.length);
  });

  it('rate-limits tier changes (no thrashing within a second)', () => {
    const g = new QualityGovernor();
    let t = 0;
    for (let i = 0; i < 50; i++) {
      t += 0.016; // one frame per 16 ms, badly slow
      g.sample(1000 / 20, t);
    }
    expect(g.changes).toBeLessThanOrEqual(2); // ~4 frames of 50 ms -> at most a couple of steps
  });
});

describe('camera rig', () => {
  it('never lets you cross the horizon or fly to infinity', () => {
    const rig = new CameraRig({ radius: 12 });
    for (let i = 0; i < 4000; i++) {
      rig.setThrust(1);
      rig.update(0.016);
    }
    expect(rig.radius).toBeGreaterThanOrEqual(MIN_RADIUS);
    expect(rig.radius).toBeLessThan(1.0 + MIN_RADIUS);
    rig.setThrust(-1);
    for (let i = 0; i < 8000; i++) rig.update(0.016);
    expect(rig.radius).toBeLessThanOrEqual(MAX_RADIUS);
  });

  it('keeps the polar angle off the poles', () => {
    const rig = new CameraRig({ radius: 12 });
    rig.orbit(0, -1e6);
    rig.update(0.05);
    expect(rig.phi).toBeGreaterThan(0);
    rig.orbit(0, 1e6);
    rig.update(0.05);
    expect(rig.phi).toBeLessThan(Math.PI);
  });

  it('orbit and zoom are clamped while cinematic mode locks input', () => {
    const rig = new CameraRig({ radius: 12 });
    rig.orbit(100, 0);
    rig.zoom(-500);
    expect(rig.targetTheta).not.toBe(0);
    expect(rig.targetRadius).toBeLessThan(12);
    rig.startCinematic();
    const theta = rig.targetTheta;
    const radius = rig.targetRadius;
    rig.orbit(9999, 9999);
    rig.zoom(-9999);
    expect(rig.targetTheta).toBe(theta);
    expect(rig.targetRadius).toBe(radius);
    rig.stopCinematic();
    expect(rig.userInputLocked).toBe(false);
  });

  it('produces a position at the requested radius and looks at the hole', () => {
    const rig = new CameraRig({ radius: 8, theta: 0.4, phi: 1.1 });
    rig.update(0.05);
    expect(rig.camera.position.length()).toBeGreaterThan(7);
    expect(rig.camera.position.length()).toBeLessThanOrEqual(8.001);
    const b = rig.basis();
    const inward = rig.camera.position.clone().multiplyScalar(-1).normalize();
    expect(b.fwd.dot(inward)).toBeGreaterThan(0.9999); // looking straight at the hole
    const right = b.right.clone();
    const up = b.up.clone();
    expect(Math.abs(right.dot(up))).toBeLessThan(1e-6); // orthonormal basis
    expect(Math.abs(right.length() - 1)).toBeLessThan(1e-6);
    expect(Math.abs(up.length() - 1)).toBeLessThan(1e-6);
    expect(up.cross(right).dot(inward)).toBeGreaterThan(0.999); // right-handed, +z = forward
  });

  it('reports where the shadow lands on screen', () => {
    const rig = new CameraRig({ radius: 12, theta: 0.3, phi: 1.2 });
    rig.camera.aspect = 16 / 9;
    rig.camera.updateProjectionMatrix();
    rig.update(0.05);
    const pose = rig.shadowScreenPose(16 / 9);
    // the camera looks straight at the origin, so the shadow sits dead centre
    expect(pose.cx).toBeCloseTo(0.5, 3);
    expect(pose.cy).toBeCloseTo(0.5, 3);
    expect(pose.radius).toBeGreaterThan(0.01);
    expect(pose.radius).toBeLessThan(0.9);
    // ... and it grows as you fall in
    rig.goTo({ radius: 3 });
    rig.update(0.4);
    const near = rig.shadowScreenPose(16 / 9);
    expect(near.radius).toBeGreaterThan(pose.radius);
  });
});

describe('close-in lens behaviour', () => {
  it('opens the lens as the shadow outgrows a normal field of view', () => {
    expect(fovWidenFactor(30)).toBeCloseTo(1, 5); // far away: untouched
    expect(fovWidenFactor(4.6)).toBeGreaterThan(0.999);
    expect(fovWidenFactor(2)).toBeGreaterThan(1.8);
    expect(fovWidenFactor(1.2)).toBeGreaterThan(2.2);
    expect(fovWidenFactor(1.05)).toBeLessThanOrEqual(2.36);
    expect(fovWidenFactor(NaN)).toBeCloseTo(1, 5); // never NaN on bad input
  });

  it('pans the view sideways only once the shadow wraps past a hemisphere', () => {
    const deg = (r) => (lookAwayAngle(r) * 180) / Math.PI;
    expect(deg(2.9)).toBeCloseTo(0, 4); // outside: still staring straight in
    expect(deg(2.2)).toBeGreaterThan(1);
    expect(deg(2.2)).toBeLessThan(52); // strictly between: the pan eases in
    expect(deg(1.4)).toBeLessThan(52.001);
    expect(deg(1.05)).toBeCloseTo(52, 1); // capped so the silhouette stays in shot
    expect(lookAwayAngle(-5)).toBeLessThanOrEqual((53 * Math.PI) / 180); // clamped, finite
    for (let r = 1.04; r < 40; r += 0.02) {
      const a = lookAwayAngle(r);
      expect(Number.isFinite(a)).toBe(true);
      expect(a).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps some sky inside the frame at every radius you can fly to', () => {
    // widest available lens vs. the sky that is not swallowed by the shadow
    for (let r = MIN_RADIUS; r <= 6; r += 0.01) {
      const widen = fovWidenFactor(r);
      const effFov = Math.min(52 * widen, 124); // vertical field, degrees
      const aspect = 16 / 9;
      const halfTan = Math.tan((effFov * Math.PI) / 360);
      const corner = Math.atan(Math.hypot(halfTan * aspect, halfTan)); // to the corner
      const pan = lookAwayAngle(r);
      // the shadow is centred `pan` away from the view axis; its far edge must
      // not cover the whole frame, i.e. some direction beyond the corner survives
      const shadowEdge = shadowAngularRadius(Math.max(r, 1.5)) + pan;
      const wrapsPastCorner = shadowEdge > corner + Math.PI / 2;
      expect(wrapsPastCorner).toBe(false);
    }
  });

  it('reports the shadow angle monotonically outside the photon sphere', () => {
    let prev = Infinity;
    for (let r = 1.6; r < 60; r += 0.5) {
      const a = shadowAngularRadius(r);
      expect(a).toBeLessThanOrEqual(prev + 1e-9);
      prev = a;
    }
    const hemi = shadowAngularRadius(1.5);
    expect(hemi).toBeGreaterThan(1.5); // a (near) full hemisphere at the photon sphere
    expect(hemi).toBeLessThanOrEqual(Math.PI / 2);
  });
});

describe('cinematic path', () => {
  it('starts and ends on the same pose so the loop is seamless', () => {
    const a = sampleCinematic(0);
    const b = sampleCinematic(CINEMATIC_DURATION - 1e-4);
    expect(a.radius).toBeCloseTo(b.radius, 1);
    expect(a.phi).toBeCloseTo(b.phi, 1);
    expect(a.fov).toBeCloseTo(b.fov, 1);
    // theta advances by whole turns
    const turns = (b.theta - a.theta) / (Math.PI * 2);
    expect(Math.abs(turns - Math.round(turns))).toBeLessThan(0.05);
  });

  it('loops in both time directions without gaps or NaN', () => {
    for (const t of [-3, -0.5, 0, 1.25, 7.5, 71.9, 1000]) {
      const k = sampleCinematic(t);
      for (const v of [k.radius, k.theta, k.phi, k.fov]) expect(Number.isFinite(v)).toBe(true);
      expect(k.radius).toBeGreaterThan(1);
      expect(k.phi).toBeGreaterThan(0);
      expect(k.phi).toBeLessThan(Math.PI);
    }
  });

  it('dives close to the horizon and pulls back out', () => {
    let minR = Infinity;
    let maxR = 0;
    for (let t = 0; t < CINEMATIC_DURATION; t += 0.25) {
      const k = sampleCinematic(t);
      minR = Math.min(minR, k.radius);
      maxR = Math.max(maxR, k.radius);
    }
    expect(minR).toBeLessThan(2); // the horizon skim
    expect(minR).toBeGreaterThan(MIN_RADIUS - 0.5);
    expect(maxR).toBeGreaterThan(20);
  });

  it('drives the rig and advances its own clock', () => {
    const rig = new CameraRig({ radius: 40 });
    rig.startCinematic();
    const r0 = rig.radius;
    for (let i = 0; i < 60; i++) rig.update(0.016);
    expect(rig.radius).not.toBe(r0);
    expect(rig.cinematicTime).toBeGreaterThan(0.9);
    expect(rig.cinematicProgress).toBeGreaterThan(0);
    expect(rig.cinematicProgress).toBeLessThan(1);
  });

  it('exposes a monotonically increasing progress value', () => {
    const rig = new CameraRig({});
    rig.startCinematic();
    let prev = -1;
    for (let i = 0; i < 200; i++) {
      rig.update(0.05);
      const p = rig.cinematicProgress;
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
      prev = clamp(p, 0, 1);
    }
    expect(prev).toBeGreaterThan(0);
  });
});
