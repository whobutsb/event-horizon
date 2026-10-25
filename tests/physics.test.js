/**
 * tests/physics.test.js — the maths behind every effect in the render.
 */

import { describe, expect, it } from 'vitest';
import {
  AU_KM,
  PHOTON_SPHERE_RS,
  SCHWARZSCHILD_KM_PER_SOL,
  SHADOW_RADIUS_RS,
  beamedFlux,
  characteristicDiskTemperature,
  clamp,
  deriveTimeStretch,
  diskTemperatureProfile,
  dopplerFactor,
  formatClock,
  formatDistanceKm,
  formatSci,
  geometricTimeSeconds,
  gravitationalRadiusKm,
  gravitationalRedshiftFactor,
  horizonRadiusRs,
  infallDrDt,
  infallDrDtau,
  infallEnergy,
  infallStartState,
  iscoRadiusRs,
  keplerianOmega,
  lorentzFactor,
  massFromSchwarzschildKm,
  orbitalBetaCirc,
  probeRedshift,
  probeTimeDilation,
  schwarzschildRadiusKm,
  smoothstep,
  stepProbe,
  timeDilationFactor,
  timeDilationFactorRs,
} from '../src/physics.js';

const MONO_SUN_RS_KM = 2.953; // textbook value for 1 M☉

describe('Schwarzschild radius', () => {
  it('gives ~2.95 km per solar mass', () => {
    expect(schwarzschildRadiusKm(1)).toBeCloseTo(MONO_SUN_RS_KM, 2);
    expect(SCHWARZSCHILD_KM_PER_SOL).toBeCloseTo(MONO_SUN_RS_KM, 2);
  });

  it('is exactly linear in mass (r_s = 2GM/c^2)', () => {
    expect(schwarzschildRadiusKm(10)).toBeCloseTo(schwarzschildRadiusKm(1) * 10, 9);
    expect(schwarzschildRadiusKm(0)).toBe(0);
  });

  it('matches known astrophysical objects', () => {
    // Sgr A*: 4.3e6 M☉ -> ~1.27e7 km (~0.085 AU, about a quarter of Mercury's orbit)
    const sgra = schwarzschildRadiusKm(4.3e6);
    expect(sgra).toBeGreaterThan(1.2e7);
    expect(sgra).toBeLessThan(1.35e7);
    expect(sgra / AU_KM).toBeCloseTo(0.085, 2);
    // M87*: 6.5e9 M☉ -> ~1.9e10 km ~ 0.002 ly
    expect(schwarzschildRadiusKm(6.5e9) / 9.4607e12).toBeLessThan(0.0021);
  });

  it('round-trips with massFromSchwarzschildKm', () => {
    for (const m of [3, 21, 4.3e6, 1.6e8, 1e9]) {
      expect(massFromSchwarzschildKm(schwarzschildRadiusKm(m))).toBeCloseTo(m, 6);
    }
  });

  it('is twice the gravitational radius', () => {
    for (const m of [1, 30, 1e7]) {
      expect(schwarzschildRadiusKm(m)).toBeCloseTo(2 * gravitationalRadiusKm(m), 12);
    }
  });

  it('rejects nonsense input', () => {
    expect(() => schwarzschildRadiusKm(-5)).toThrow(RangeError);
    expect(() => schwarzschildRadiusKm(NaN)).toThrow(RangeError);
    expect(() => schwarzschildRadiusKm(Infinity)).toThrow(RangeError);
  });
});

describe('gravitational time dilation', () => {
  it('is sqrt(1 - r_s/r)', () => {
    expect(timeDilationFactor(2, 1)).toBeCloseTo(Math.SQRT1_2, 12);
    // r chosen so that 1 - r_s/r = 0.5625 -> dilation exactly 0.75
    expect(timeDilationFactor(1 / (1 - 0.5625), 1)).toBeCloseTo(0.75, 12);
    expect(timeDilationFactorRs(4)).toBeCloseTo(Math.sqrt(0.75), 12);
  });

  it('freezes exactly at and inside the horizon instead of going NaN', () => {
    expect(timeDilationFactor(1, 1)).toBe(0);
    expect(timeDilationFactor(0.4, 1)).toBe(0);
    expect(Number.isNaN(timeDilationFactor(1, 1))).toBe(false);
  });

  it('approaches 1 far away and is monotonically increasing', () => {
    expect(timeDilationFactor(1e9, 1)).toBeGreaterThan(0.99999);
    let prev = -1;
    for (let r = 1.0; r < 60; r += 0.05) {
      const d = timeDilationFactor(r, 1);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });

  it('never leaves [0,1] and rejects nonsense', () => {
    for (const r of [1.0001, 1.5, 3, 20, 1e6]) {
      const d = timeDilationFactor(r, 1);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1);
    }
    expect(() => timeDilationFactor(-1, 1)).toThrow(RangeError);
    expect(() => timeDilationFactor(2, NaN)).toThrow(RangeError);
  });

  it('is small enough near the horizon to visibly slow the ship clock', () => {
    // the rig's closest approach is ~1.012 r_s: the clock must run >= 5x slower
    expect(timeDilationFactorRs(1.045)).toBeLessThan(0.25);
    expect(timeDilationFactorRs(1.012)).toBeLessThan(0.12);
  });
});

describe('gravitational redshift between static observers', () => {
  it('is unity for emitter and observer at the same radius', () => {
    expect(gravitationalRedshiftFactor(7, 7, 1)).toBeCloseTo(1, 12);
  });

  it('reddens light climbing out and blueshifts it falling in', () => {
    expect(gravitationalRedshiftFactor(3, 20, 1)).toBeLessThan(1);
    expect(gravitationalRedshiftFactor(20, 3, 1)).toBeGreaterThan(1);
  });

  it('is reciprocal: g(a->b) * g(b->a) = 1', () => {
    const ab = gravitationalRedshiftFactor(4, 30, 1);
    const ba = gravitationalRedshiftFactor(30, 4, 1);
    expect(ab * ba).toBeCloseTo(1, 12);
  });

  it('goes to zero for an emitter at the horizon', () => {
    expect(gravitationalRedshiftFactor(1.000001, 10, 1)).toBeLessThan(0.01);
    expect(gravitationalRedshiftFactor(0.9, 10, 1)).toBe(0);
  });
});

describe('special-relativistic Doppler beaming', () => {
  it('has no shift at rest', () => {
    expect(dopplerFactor(0, 1)).toBeCloseTo(1, 12);
    expect(dopplerFactor(0, 0)).toBeCloseTo(1, 12);
    expect(lorentzFactor(0)).toBe(1);
  });

  it('matches the analytic head-on value: beta=0.5 -> sqrt(3)', () => {
    expect(dopplerFactor(0.5, 1)).toBeCloseTo(Math.sqrt(3), 12);
    expect(dopplerFactor(0.5, -1)).toBeCloseTo(1 / Math.sqrt(3), 12);
  });

  it('gives the transverse Doppler redshift 1/gamma at 90 degrees', () => {
    for (const b of [0.1, 0.5, 0.9]) {
      expect(dopplerFactor(b, 0)).toBeCloseTo(1 / lorentzFactor(b), 12);
    }
  });

  it('makes the approaching side brighter/bluer and the receding side dimmer/redder', () => {
    const beta = orbitalBetaCirc(3); // 0.5 c at the Schwarzschild ISCO
    const towards = dopplerFactor(beta, 1);
    const away = dopplerFactor(beta, -1);
    expect(towards).toBeGreaterThan(1);
    expect(away).toBeLessThan(1);
    expect(beamedFlux(towards, 3)).toBeGreaterThan(4);
    expect(beamedFlux(away, 3)).toBeLessThan(0.25);
    // g(approaching) * g(receding) = 1 exactly: 1/(g^2(1-b^2)) == 1
    expect(towards * away).toBeCloseTo(1, 9);
  });

  it('is monotonically increasing in cos(theta)', () => {
    let prev = 0;
    for (let mu = -1; mu <= 1.0001; mu += 0.05) {
      const g = dopplerFactor(0.6, mu);
      expect(g).toBeGreaterThan(prev);
      prev = g;
    }
  });

  it('refuses superluminal speeds', () => {
    expect(() => dopplerFactor(1, 0)).toThrow(RangeError);
    expect(() => dopplerFactor(1.2, 0)).toThrow(RangeError);
    expect(() => lorentzFactor(-1)).toThrow(RangeError);
    expect(() => dopplerFactor(NaN, 0)).toThrow(RangeError);
  });

  it('clamps cos(theta) instead of producing NaN', () => {
    expect(dopplerFactor(0.4, 5)).toBeCloseTo(dopplerFactor(0.4, 1), 12);
    expect(dopplerFactor(0.4, -5)).toBeCloseTo(dopplerFactor(0.4, -1), 12);
  });

  it('beamedFlux uses the requested power law', () => {
    expect(beamedFlux(2, 3)).toBeCloseTo(8, 12);
    expect(beamedFlux(2, 4)).toBeCloseTo(16, 12);
    expect(beamedFlux(1, 3)).toBeCloseTo(1, 12);
  });
});

describe('circular orbits, photon sphere and ISCO', () => {
  it('PHOTON_SPHERE_RS and the shadow radius are the classic values', () => {
    expect(PHOTON_SPHERE_RS).toBe(1.5);
    expect(SHADOW_RADIUS_RS).toBeCloseTo((3 * Math.sqrt(3)) / 2, 12);
    expect(SHADOW_RADIUS_RS).toBeCloseTo(2.598076, 5);
  });

  it('orbital speed is c/2 at the Schwarzschild ISCO and -> c at the photon sphere', () => {
    expect(orbitalBetaCirc(3)).toBeCloseTo(0.5, 12);
    expect(orbitalBetaCirc(1.5 + 1e-6)).toBeGreaterThan(0.99);
    expect(orbitalBetaCirc(100)).toBeLessThan(0.1);
  });

  it('orbital speed decreases outward and stays subluminal', () => {
    let prev = Infinity;
    for (let r = 1.5001; r < 200; r *= 1.05) {
      const b = orbitalBetaCirc(r);
      expect(b).toBeLessThan(prev);
      expect(b).toBeLessThan(1);
      prev = b;
    }
  });

  it('refuses circular orbits inside the photon sphere', () => {
    expect(() => orbitalBetaCirc(1.5)).toThrow(RangeError);
    expect(() => orbitalBetaCirc(1)).toThrow(RangeError);
    expect(() => orbitalBetaCirc(NaN)).toThrow(RangeError);
  });

  it('Keplerian Omega falls off as r^-3/2', () => {
    expect(keplerianOmega(4) / keplerianOmega(1)).toBeCloseTo(Math.pow(4, -1.5), 10);
    expect(keplerianOmega(1)).toBeCloseTo(Math.sqrt(0.5), 12);
    expect(() => keplerianOmega(0)).toThrow(RangeError);
  });

  it('ISCO shrinks from 3 r_s (a=0) towards 0.5 r_s (extremal)', () => {
    expect(iscoRadiusRs(0)).toBeCloseTo(3, 9); // 6 GM/c^2
    expect(iscoRadiusRs(0.5)).toBeCloseTo(2.1165, 3); // 4.233 GM/c^2
    expect(iscoRadiusRs(0.9)).toBeCloseTo(1.1604, 3); // 2.321 GM/c^2
    expect(iscoRadiusRs(0.998)).toBeLessThan(1.0);
    expect(iscoRadiusRs(0.999999)).toBeGreaterThan(0.5);
  });

  it('ISCO is monotonically decreasing in spin and always outside the horizon', () => {
    let prev = Infinity;
    for (let a = 0; a <= 0.999; a += 0.01) {
      const r = iscoRadiusRs(a);
      expect(r).toBeGreaterThan(0.5 - 1e-9);
      expect(r).toBeLessThanOrEqual(prev + 1e-12);
      prev = r;
    }
  });

  it('the Kerr horizon shrinks from r_s to half of it as spin grows', () => {
    expect(horizonRadiusRs(0)).toBeCloseTo(1, 9);
    expect(horizonRadiusRs(0.5)).toBeCloseTo((1 + Math.sqrt(0.75)) / 2, 12);
    expect(horizonRadiusRs(0.998)).toBeGreaterThan(0.5);
    expect(horizonRadiusRs(0.998)).toBeLessThan(0.54);
    let prev = Infinity;
    for (let a = 0; a <= 0.999; a += 0.01) {
      const h = horizonRadiusRs(a);
      expect(h).toBeLessThanOrEqual(prev + 1e-12);
      prev = h;
    }
    expect(() => horizonRadiusRs('x')).toThrow(RangeError);
  });

  it('the ISCO always stays outside the horizon, even at extreme spin', () => {
    for (let a = 0; a < 0.999; a += 0.005) {
      expect(iscoRadiusRs(a)).toBeGreaterThan(horizonRadiusRs(a));
    }
  });

  it('clamps absurd spins and rejects non-finite ones', () => {
    expect(iscoRadiusRs(-0.9)).toBeCloseTo(iscoRadiusRs(0.9), 12);
    expect(iscoRadiusRs(50)).toBeGreaterThan(0.5);
    expect(() => iscoRadiusRs(NaN)).toThrow(RangeError);
    expect(() => iscoRadiusRs(undefined)).toThrow(RangeError);
  });
});

describe('thin-disk temperature profile', () => {
  const rIn = 3;

  it('vanishes at and inside the inner edge', () => {
    expect(diskTemperatureProfile(rIn, rIn)).toBe(0);
    expect(diskTemperatureProfile(1, rIn)).toBe(0);
  });

  it('peaks at exactly 1.0 near r = 9/7 * r_in', () => {
    let best = 0;
    let bestR = 0;
    for (let r = rIn + 1e-4; r < 60; r += 1e-4) {
      const v = diskTemperatureProfile(r, rIn);
      if (v > best) {
        best = v;
        bestR = r;
      }
    }
    expect(best).toBeCloseTo(1, 4);
    expect(bestR).toBeCloseTo((9 / 7) * rIn, 2);
  });

  it('stays in [0,1] and decays outward', () => {
    for (let r = rIn; r < 400; r += 0.37) {
      const v = diskTemperatureProfile(r, rIn);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1 + 1e-9);
    }
    const a = diskTemperatureProfile(6, rIn);
    const b = diskTemperatureProfile(30, rIn);
    const c = diskTemperatureProfile(120, rIn);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
    expect(c).toBeGreaterThan(0);
  });

  it('returns 0 for degenerate geometry instead of NaN', () => {
    expect(diskTemperatureProfile(5, 0)).toBe(0);
    expect(diskTemperatureProfile(NaN, 3)).toBe(0);
    expect(diskTemperatureProfile(Infinity, 3)).toBe(0);
  });
});

describe('radial infall of the probe', () => {
  const r0 = 10;

  it('has specific energy sqrt(1 - r_s/r0), and 1 when dropped from infinity', () => {
    expect(infallEnergy(r0, 1)).toBeCloseTo(Math.sqrt(1 - 0.1), 12);
    expect(infallEnergy(Infinity, 1)).toBeCloseTo(1, 9);
    expect(infallEnergy(1, 1)).toBe(1); // dropped from the horizon: marginally bound
  });

  it('speeds up as it falls (proper velocity)', () => {
    const a = infallDrDtau(8, r0, 1);
    const b = infallDrDtau(3, r0, 1);
    const c = infallDrDtau(1.01, r0, 1);
    expect(a).toBeLessThan(0);
    expect(Math.abs(b)).toBeGreaterThan(Math.abs(a));
    expect(Math.abs(c)).toBeGreaterThan(Math.abs(b));
    // at the release point it starts from rest
    expect(infallDrDtau(r0, r0, 1)).toBeCloseTo(0, 9);
  });

  it('freezes in coordinate time: dr/dt -> 0 at the horizon', () => {
    const far = infallDrDt(8, r0, 1);
    const near = infallDrDt(1.0001, r0, 1);
    expect(Math.abs(near)).toBeLessThan(Math.abs(far));
    expect(Math.abs(near)).toBeLessThan(1e-3);
    expect(infallDrDt(1, r0, 1)).toBeCloseTo(0, 12);
  });

  it('time dilation dt/dtau grows without bound towards the horizon', () => {
    const a = probeTimeDilation(8, r0, 1);
    const b = probeTimeDilation(3, r0, 1);
    const c = probeTimeDilation(1.001, r0, 1);
    expect(a).toBeGreaterThan(1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b * 100);
  });

  it('redshift reduces to the pure gravitational factor at the release point', () => {
    // momentarily at rest there, so g must equal sqrt(1 - r_s/r0)
    expect(probeRedshift(r0, r0, 1)).toBeCloseTo(Math.sqrt(1 - 1 / r0), 9);
  });

  it('redshift fades to nothing at the horizon and is monotonic', () => {
    let prev = Infinity;
    for (let r = r0; r > 1.0000001; r *= 0.97) {
      const g = probeRedshift(r, r0, 1);
      expect(g).toBeLessThanOrEqual(prev + 1e-12);
      expect(g).toBeGreaterThanOrEqual(0);
      prev = g;
    }
    expect(probeRedshift(1.0000001, r0, 1)).toBeLessThan(1e-4);
  });

  it('observed from a finite radius the ship is deeper in the well, so it sees a blueshift relative to infinity', () => {
    const fromInfinity = probeRedshift(2, r0, 1);
    const fromShip = probeRedshift(2, r0, 1, 12);
    expect(fromShip).toBeGreaterThan(fromInfinity);
  });

  it('starts a body released from rest (the nudge breaks the unstable equilibrium)', () => {
    const s0 = infallStartState(r0);
    expect(s0.r).toBeLessThan(r0);
    expect(s0.t).toBe(0);
    expect(infallDrDt(s0.r, r0, 1)).toBeLessThan(0);
    expect(() => infallStartState(0)).not.toThrow();
  });

  it('RK4 integration is monotone, never crosses the horizon and keeps tau < t', () => {
    let s = infallStartState(r0);
    let prev = Infinity;
    for (let i = 0; i < 5000; i++) {
      s = stepProbe(s, 0.01, r0);
      expect(s.r).toBeLessThanOrEqual(prev + 1e-12);
      expect(s.r).toBeGreaterThanOrEqual(1);
      expect(s.tau).toBeLessThan(s.t);
      prev = s.r;
    }
  });

  it('freezes onto the horizon in coordinate time while its own clock runs on', () => {
    let s = infallStartState(10);
    for (let i = 0; i < 5000; i++) s = stepProbe(s, 0.01, 10); // t = 50
    expect(s.r).toBeGreaterThan(2); // still visibly falling at t = 50 r_s/c
    const midRatio = s.tau / s.t;
    for (let i = 0; i < 10000; i++) s = stepProbe(s, 0.01, 10); // t = 150
    expect(s.r).toBeLessThanOrEqual(1.001); // asymptotically parked on the horizon
    expect(s.tau / s.t).toBeLessThan(midRatio); // and its clock keeps falling behind
    expect(probeRedshift(s.r, 10, 1)).toBeLessThan(0.01); // ... reddened into invisibility
  });

  it('free fall takes longer from further out (t ~ r0^1.5)', () => {
    const timeToReach = (r0x, target) => {
      let s = infallStartState(r0x);
      for (let i = 0; i < 2e5; i++) {
        s = stepProbe(s, 0.01, r0x);
        if (s.r <= target) return s.t;
      }
      return Infinity;
    };
    const t8 = timeToReach(8, 2);
    const t16 = timeToReach(16, 2);
    expect(t8).toBeLessThan(t16);
    expect(t16 / t8).toBeGreaterThan(1.4); // Newtonian free-fall scaling is steeper
  });

  it('a probe dropped from closer in stays slower than one dropped from far out', () => {
    let near = infallStartState(4);
    let far = infallStartState(30);
    far.r = near.r; // same starting radius, different energy
    for (let i = 0; i < 200; i++) {
      near = stepProbe(near, 0.01, 4);
      far = stepProbe(far, 0.01, 30);
    }
    expect(far.r).toBeLessThan(near.r); // more energy -> falls faster
  });
});

describe('clock and star-stretch helpers', () => {
  it('deriveTimeStretch is 0 far away and saturates near the horizon', () => {
    expect(deriveTimeStretch(1)).toBe(0);
    expect(deriveTimeStretch(0.96)).toBeGreaterThan(0.05);
    expect(deriveTimeStretch(0.1)).toBeCloseTo(1, 6);
    expect(deriveTimeStretch(0)).toBe(1);
    expect(deriveTimeStretch(NaN)).toBe(0);
  });

  it('deriveTimeStretch is monotonic in the dilation factor', () => {
    let prev = -1;
    for (let d = 1; d >= 0; d -= 0.02) {
      const s = deriveTimeStretch(d);
      expect(s).toBeGreaterThanOrEqual(prev);
      expect(s).toBeLessThanOrEqual(1);
      prev = s;
    }
  });

  it('geometricTimeSeconds is GM/c^3: 4.925 microseconds per solar mass', () => {
    expect(Math.abs(geometricTimeSeconds(1) / 4.9255e-6 - 1)).toBeLessThan(1e-4);
    expect(geometricTimeSeconds(4.3e6)).toBeCloseTo(21.2, 0);
    expect(geometricTimeSeconds(1e8) / geometricTimeSeconds(1)).toBeCloseTo(1e8, 3);
    expect(() => geometricTimeSeconds(-1)).toThrow(RangeError);
  });

  it('clamp/lerp/smoothstep behave', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 12);
    expect(smoothstep(2, 4, 3)).toBeCloseTo(0.5, 12);
    expect(smoothstep(2, 4, -100)).toBe(0);
    expect(smoothstep(2, 4, 100)).toBe(1);
  });
});

describe('HUD formatting', () => {
  it('picks sensible distance units', () => {
    expect(formatDistanceKm(1234)).toContain('km');
    expect(formatDistanceKm(5e7)).toContain('million km');
    expect(formatDistanceKm(1.5e8)).toContain('AU');
    expect(formatDistanceKm(4e13)).toContain('ly');
    expect(formatDistanceKm(Infinity)).toBe('inf');
  });

  it('formats clocks as HH:MM:SS.mmm', () => {
    expect(formatClock(0)).toBe('00:00:00.000');
    expect(formatClock(3661.5)).toBe('01:01:01.500');
    expect(formatClock(-4)).toBe('00:00:00.000');
    expect(formatClock(NaN)).toBe('--:--:--.---');
  });

  it('formats scientific notation for extreme numbers', () => {
    expect(formatSci(1.6e8)).toBe('1.60e+8');
    expect(formatSci(0.0021, 2)).toBe('2.1e-3');
    expect(formatSci(0)).toBe('0');
  });
});

describe('physical disk temperature', () => {
  it('scales as M^-1/4 (supermassive disks are cooler)', () => {
    const stellar = characteristicDiskTemperature(10, 0.1);
    const sme = characteristicDiskTemperature(1e8, 0.1);
    expect(stellar).toBeGreaterThan(sme);
    expect(stellar / sme).toBeCloseTo(Math.pow(1e7, 0.25), 1);
  });

  it('lands in the X-ray/UV regime: hot for stellar, far-UV for supermassive', () => {
    expect(characteristicDiskTemperature(10, 0.1)).toBeGreaterThan(1e5);
    expect(characteristicDiskTemperature(10, 0.1)).toBeLessThan(1e7);
    expect(characteristicDiskTemperature(1.6e8, 0.01)).toBeGreaterThan(1e4);
    expect(characteristicDiskTemperature(1.6e8, 0.01)).toBeLessThan(1e6);
  });

  it('grows with accretion rate and rejects bad mass', () => {
    expect(characteristicDiskTemperature(10, 0.5)).toBeGreaterThan(
      characteristicDiskTemperature(10, 0.05),
    );
    expect(() => characteristicDiskTemperature(-3)).toThrow(RangeError);
  });
});
