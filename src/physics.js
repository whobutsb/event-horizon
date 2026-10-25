/**
 * physics.js — Schwarzschild / Kerr-ISCO maths for "Event Horizon".
 *
 * Pure functions only: no Three.js, no DOM, no globals. Everything here is unit
 * tested (tests/physics.test.js) and the same expressions are mirrored in the
 * GLSL shaders (see src/shaders/blackHole.js) so what you see on screen is what
 * the HUD numbers.
 *
 * Unit conventions
 * ----------------
 *  * "Km"  arguments are kilometres.
 *  * "Rs"  arguments are multiples of the Schwarzschild radius r_s = 2GM/c^2
 *          (this is the unit the renderer works in: r_s === 1).
 *  * Speeds returned with a `Beta` suffix are fractions of c (dimensionless).
 *  * massSolar is in solar masses.
 */

// ---------------------------------------------------------------------------
// Constants (SI, CODATA 2018)
// ---------------------------------------------------------------------------

export const G = 6.6743e-11; // m^3 kg^-1 s^-2
export const C = 299792458; // m s^-1
export const M_SUN = 1.98847e30; // kg (IAU nominal solar mass)
export const AU_KM = 1.495978707e8; // km
export const LY_KM = 9.4607304725808e12; // km

/** r_s per solar mass, in km: 2GM_sun/c^2 = 2.953 km */
export const SCHWARZSCHILD_KM_PER_SOL = (2 * G * M_SUN / 1e3) / (C * C);

/** Photon sphere radius in units of r_s (r = 3GM/c^2). */
export const PHOTON_SPHERE_RS = 1.5;

/**
 * Critical impact parameter b_crit = 3*sqrt(3) * GM/c^2, in units of r_s.
 * This is the apparent angular radius of the shadow for a distant observer.
 */
export const SHADOW_RADIUS_RS = (3 * Math.sqrt(3)) / 2; // 2.598076...

// ---------------------------------------------------------------------------
// Small numeric helpers (shared by every module)
// ---------------------------------------------------------------------------

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Hermite smoothstep. */
export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1e-12), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Map a value through a log10 slider (used by the mass control). */
export function logMap(t, lo, hi) {
  return Math.pow(10, lerp(Math.log10(lo), Math.log10(hi), clamp(t, 0, 1)));
}

export function logUnmap(value, lo, hi) {
  return clamp(
    (Math.log10(value) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)),
    0,
    1,
  );
}

function assertPositive(name, ...pairs) {
  for (const [v, label] of pairs) {
    if (!Number.isFinite(v)) throw new RangeError(`${label || name}: expected a finite number, got ${v}`);
    if (v < 0) throw new RangeError(`${label || name}: expected >= 0, got ${v}`);
  }
}

// ---------------------------------------------------------------------------
// Schwarzschild geometry
// ---------------------------------------------------------------------------

/**
 * Schwarzschild radius of a non-rotating body of `massSolar` solar masses.
 *   r_s = 2GM / c^2
 * @param {number} massSolar mass in solar masses
 * @returns {number} r_s in kilometres
 */
export function schwarzschildRadiusKm(massSolar) {
  assertPositive('schwarzschildRadiusKm', [massSolar, 'massSolar']);
  return SCHWARZSCHILD_KM_PER_SOL * massSolar;
}

/** Gravitational radius GM/c^2 in km (half the Schwarzschild radius). */
export function gravitationalRadiusKm(massSolar) {
  return schwarzschildRadiusKm(massSolar) * 0.5;
}

/** Inverse of schwarzschildRadiusKm: solar mass from a radius in km. */
export function massFromSchwarzschildKm(rsKm) {
  assertPositive('massFromSchwarzschildKm', [rsKm, 'rsKm']);
  return rsKm / SCHWARZSCHILD_KM_PER_SOL;
}

/**
 * Gravitational time dilation for a *static* observer at radius r:
 *   dtau/dt = sqrt(1 - r_s / r)
 * A clock sitting at the horizon is frozen as seen from far away, so the
 * factor saturates at 0 for r <= r_s instead of going NaN.
 * @returns {number} in [0, 1]
 */
export function timeDilationFactor(rKm, rsKm) {
  assertPositive('timeDilationFactor', [rKm, 'r'], [rsKm, 'r_s']);
  if (rKm <= rsKm) return 0;
  return Math.sqrt(1 - rsKm / rKm);
}

/** Same thing expressed directly in r_s units. */
export function timeDilationFactorRs(rRs) {
  return timeDilationFactor(rRs, 1);
}

/**
 * How far the sky should smear radially for a ship clock running at `dilation`.
 * 0 = far away and still, 1 = grazing the horizon (stars become radial streaks).
 */
export function deriveTimeStretch(dilation) {
  const d = Number.isFinite(dilation) ? clamp(dilation, 0, 1) : 1;
  return clamp(Math.pow(1 - d, 0.75) * 1.15, 0, 1);
}

/**
 * Gravitational redshift nu_obs / nu_emit between two *static* observers.
 *   g = sqrt( (1 - r_s/r_emit) / (1 - r_s/r_obs) )
 * g < 1 means the light is reddened climbing out.
 */
export function gravitationalRedshiftFactor(rEmitKm, rObsKm, rsKm) {
  assertPositive('gravitationalRedshiftFactor', [rEmitKm, 'r_emit'], [rObsKm, 'r_obs'], [rsKm, 'r_s']);
  if (rEmitKm <= rsKm || rObsKm <= rsKm) return 0;
  const ge = 1 - rsKm / rEmitKm;
  const go = 1 - rsKm / rObsKm;
  return Math.sqrt(ge / go);
}

/** Characteristic relativistic timescale GM/c^3, in seconds. */
export function geometricTimeSeconds(massSolar) {
  assertPositive('geometricTimeSeconds', [massSolar, 'massSolar']);
  return (G * massSolar * M_SUN) / Math.pow(C, 3);
}

// ---------------------------------------------------------------------------
// Special-relativistic Doppler beaming
// ---------------------------------------------------------------------------

/** Lorentz factor gamma = 1/sqrt(1-beta^2). */
export function lorentzFactor(beta) {
  if (!Number.isFinite(beta) || Math.abs(beta) >= 1) {
    throw new RangeError(`lorentzFactor: |beta| must be < 1, got ${beta}`);
  }
  return 1 / Math.sqrt(1 - beta * beta);
}

/**
 * Relativistic Doppler factor g = nu_obs / nu_emit for an emitter moving with
 * speed beta*c whose velocity makes an angle `cosTheta` with the line of sight
 * *towards the observer*:
 *   g = 1 / (gamma * (1 - beta*cos(theta)))
 *  cosTheta = +1  -> approaching (blueshift, g > 1)
 *  cosTheta =  0  -> transverse (pure time-dilation redshift, g = 1/gamma)
 *  cosTheta = -1  -> receding   (redshift, g < 1)
 */
export function dopplerFactor(beta, cosTheta) {
  if (!Number.isFinite(beta) || Math.abs(beta) >= 1) {
    throw new RangeError(`dopplerFactor: |beta| must be < 1, got ${beta}`);
  }
  const mu = clamp(cosTheta, -1, 1);
  return 1 / (lorentzFactor(beta) * (1 - beta * mu));
}

/**
 * Observed / emitted specific intensity for a moving source.
 * I_nu / nu^3 is invariant, so broadband emission scales like g^alpha with
 * alpha = 3 for specific intensity and alpha = 4 for bolometric ("Doppler
 * boosting"). The renderer uses alpha = 3.
 */
export function beamedFlux(g, alpha = 3) {
  assertPositive('beamedFlux', [g, 'g']);
  return Math.pow(g, alpha);
}

/** Combined shift factor used by the disk shader: Doppler x gravitational. */
export function diskShiftFactor(beta, cosTheta, rEmitRs, rObsRs) {
  const gD = dopplerFactor(beta, cosTheta);
  const gG = gravitationalRedshiftFactor(rEmitRs, rObsRs, 1);
  return gD * gG;
}

// ---------------------------------------------------------------------------
// Circular orbits, ISCO and the disk spectrum
// ---------------------------------------------------------------------------

/**
 * Orbital speed (relative to a local static observer, in units of c) of a
 * circular geodesic at radius r = rRs * r_s:
 *   beta = sqrt( (r_s/2) / (r - r_s) )
 * It reaches c at the photon sphere (r = 1.5 r_s) and equals 0.5 c at the
 * Schwarzschild ISCO (r = 3 r_s). Circular timelike orbits require r > 1.5 r_s.
 */
export function orbitalBetaCirc(rRs) {
  if (!Number.isFinite(rRs) || rRs <= PHOTON_SPHERE_RS) {
    throw new RangeError(`orbitalBetaCirc: need r > ${PHOTON_SPHERE_RS} r_s, got ${rRs}`);
  }
  return clamp(Math.sqrt(0.5 / (rRs - 1)), 0, 0.999);
}

/** Keplerian angular frequency Omega = sqrt(GM/r^3), in units of c^3/(GM)... */
export function keplerianOmega(rRs) {
  if (!Number.isFinite(rRs) || rRs <= 0) throw new RangeError(`keplerianOmega: bad r ${rRs}`);
  // In r_s units with GM = c = 1 => r_s = 2, so Omega*r_s/c = sqrt(0.5)/r^{3/2}
  return Math.sqrt(0.5) / Math.pow(rRs, 1.5);
}

/**
 * Prograde ISCO radius from the Bardeen-Press-Teukolsky (1972) formula for a
 * Kerr black hole with dimensionless spin a* = Jc/GM^2.
 * Returned in units of r_s (divide the usual GM/c^2 result by 2).
 *   a* = 0     -> 3.0 r_s      (6 GM/c^2)
 *   a* = 0.9   -> ~1.16 r_s
 *   a* -> 1    -> 0.5 r_s
 */
export function iscoRadiusRs(spin) {
  if (!Number.isFinite(spin)) throw new RangeError(`iscoRadiusRs: spin must be finite, got ${spin}`);
  const a = clamp(Math.abs(spin), 0, 1 - 1e-9);
  const oneMinusA2 = Math.cbrt(1 - a * a);
  const z1 = 1 + oneMinusA2 * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
  const z2 = Math.sqrt(3 * a * a + z1 * z1);
  const rGm = 3 + z2 - Math.sqrt(Math.max(0, (3 - z1) * (3 + z1 + 2 * z2)));
  return rGm / 2;
}

/**
 * Outer (event) horizon radius of a Kerr hole with spin a*, in units of r_s:
 *   r_+ / r_s = (1 + sqrt(1 - a*^2)) / 2
 * a* = 0 -> 1, a* -> 1 -> 0.5. The prograde ISCO always stays outside this.
 */
export function horizonRadiusRs(spin) {
  if (!Number.isFinite(spin)) throw new RangeError(`horizonRadiusRs: spin must be finite, got ${spin}`);
  const a = clamp(Math.abs(spin), 0, 1 - 1e-12);
  return (1 + Math.sqrt(1 - a * a)) / 2;
}

/** Outer edge of the radiating disk, in r_s (a visual choice, not physics). */
export const DISK_OUTER_RS = 13.5;

/**
 * Normalised thin-disk temperature profile (Shakura-Sunyaev standard model):
 *   T(r) = T_peak * N * u^{-3/4} (1 - u^{-1/2})^{1/4},  u = r / r_in
 * N is chosen so the maximum is exactly 1; the peak sits at u = 9/7.
 * Returns 0 inside the inner edge and for u -> infinity.
 */
export function diskTemperatureProfile(rRs, rInnerRs) {
  if (!Number.isFinite(rRs) || !Number.isFinite(rInnerRs) || rInnerRs <= 0) return 0;
  const u = rRs / rInnerRs;
  if (u <= 1) return 0;
  const shape = Math.pow(u, -0.75) * Math.pow(1 - Math.sqrt(1 / u), 0.25);
  // max of u^{-3/4}(1-u^{-1/2})^{1/4} is at u = 9/7 and equals ~0.4837
  const NORM = 1 / (Math.pow(9 / 7, -0.75) * Math.pow(1 - Math.sqrt(7 / 9), 0.25));
  return clamp(shape * NORM, 0, 1);
}

/**
 * Peak effective temperature of a steady Shakura-Sunyaev thin disk
 *   T_max = 0.488 * ( 3 G M mdot / (8 pi sigma r_in^3) )^{1/4}
 * with r_in = the ISCO for a non-spinning hole and mdot set by an Eddington
 * fraction (radiative efficiency eta = 0.1). Scales like M^{-1/4}: supermassive
 * holes radiate mostly in the UV, stellar-mass holes in X-rays.
 *
 * NOTE: this is the *physical* effective temperature, shown in the HUD. The
 * colour you see on screen is the "disk temperature" slider, because we render
 * a narrow optical band and shift the spectrum for legibility.
 */
export function characteristicDiskTemperature(massSolar, eddingtonFraction = 0.1) {
  assertPositive('characteristicDiskTemperature', [massSolar, 'massSolar']);
  const SIGMA_SB = 5.670374419e-8; // W m^-2 K^-4
  const LEDD_PER_MSUN = 1.26e31; // W
  const ETA = 0.1;
  const M = massSolar * M_SUN;
  const mdot = (eddingtonFraction * LEDD_PER_MSUN * massSolar) / (ETA * C * C); // kg s^-1
  const rIn = 6 * ((G * M) / (C * C)); // m, Schwarzschild ISCO
  const flux = (3 * G * M * mdot) / (8 * Math.PI * SIGMA_SB * Math.pow(rIn, 3));
  return 0.488 * Math.pow(Math.max(flux, 0), 0.25);
}

// ---------------------------------------------------------------------------
// Radial free fall from rest (the probe)
// ---------------------------------------------------------------------------

/**
 * Specific energy E = (1 - r_s/r) dt/dtau of a particle released from rest at
 * r0 (per unit rest mass, c = 1). E = 1 for an object dropped from infinity.
 */
export function infallEnergy(r0Km, rsKm) {
  if (r0Km === Infinity) return 1; // released from rest at infinity
  assertPositive('infallEnergy', [r0Km, 'r0'], [rsKm, 'r_s']);
  if (r0Km <= rsKm) return 1;
  return Math.sqrt(1 - rsKm / r0Km);
}

/**
 * Initial state for "released from rest at r0".
 *
 * Exactly at r0 the energy equation gives dr/dtau = 0, and because that square
 * root is not Lipschitz the ODE would happily sit there forever. A real ship
 * has a thruster, so we start it an imperceptible nudge inward: the subsequent
 * fall is then purely geodesic (this choice does not change any observable).
 */
export function infallStartState(r0Rs, nudge = 2e-3) {
  const r0 = Math.max(Number(r0Rs), 1 + 1e-6);
  return { r: r0 * (1 - clamp(nudge, 0, 0.2)), t: 0, tau: 0 };
}

/** dr/dtau in units of c (negative: falling inward). */
export function infallDrDtau(rKm, r0Km, rsKm) {
  const E = infallEnergy(r0Km, rsKm);
  assertPositive('infallDrDtau', [rKm, 'r']);
  if (rKm <= 0) return -Infinity;
  return -Math.sqrt(Math.max(0, E * E - 1 + rsKm / rKm));
}

/** dt/dtau — the probe's gravitational+kinematic time dilation factor. */
export function probeTimeDilation(rKm, r0Km, rsKm) {
  const E = infallEnergy(r0Km, rsKm);
  assertPositive('probeTimeDilation', [rKm, 'r']);
  const f = 1 - rsKm / Math.max(rKm, rsKm * (1 + 1e-12));
  return E / Math.max(f, 1e-300);
}

/** dr/dt in units of c. Goes to 0 at the horizon: the probe "freezes". */
export function infallDrDt(rKm, r0Km, rsKm) {
  const f = 1 - rsKm / Math.max(rKm, 1e-300);
  return f * infallDrDtau(rKm, r0Km, rsKm);
}

/**
 * Redshift nu_obs/nu_emit of a photon emitted outward at radius r by a probe
 * dropped from rest at r0 and received by a static observer at rObs:
 *   g = (1 - r_s/r) / ( E + sqrt(E^2 - 1 + r_s/r) )   x  1/sqrt(1 - r_s/r_obs)
 * At the release point this reduces to sqrt(1 - r_s/r0) (pure gravitational
 * shift, the probe is momentarily at rest) and it -> 0 at the horizon.
 */
export function probeRedshift(rKm, r0Km, rsKm, rObsKm = Infinity) {
  const E = infallEnergy(r0Km, rsKm);
  assertPositive('probeRedshift', [rKm, 'r']);
  const r = Math.max(rKm, rsKm * (1 + 1e-12));
  const f = 1 - rsKm / r;
  const g = f / (E + Math.sqrt(Math.max(0, E * E - 1 + rsKm / r)));
  if (!Number.isFinite(rObsKm)) return g;
  const fo = 1 - rsKm / Math.max(rObsKm, rsKm * (1 + 1e-9));
  return g / Math.sqrt(Math.max(fo, 1e-12));
}

/**
 * One explicit-Euler-free RK4 step of the probe's radius in *coordinate* time,
 * so the freeze at the horizon is automatic. Returns {r, t, tau}.
 *   dr/dt = -(1 - r_s/r) sqrt(E^2 - 1 + r_s/r)
 *   dtau/dt = (1 - r_s/r)/E
 * @param {{r:number,t:number,tau:number}} state   units: r in r_s, t/tau in GM/c^3*2
 * @param {number} dt  coordinate-time step
 * @param {number} r0  release radius in r_s
 */
export function stepProbe(state, dt, r0Rs) {
  const rs = 1;
  const drdt = (r) => infallDrDt(Math.max(r, rs * (1 + 1e-9)), r0Rs, rs);
  const dtaudt = (r) => {
    const E = infallEnergy(r0Rs, rs);
    return Math.max(0, (1 - rs / Math.max(r, rs * (1 + 1e-9))) / E);
  };
  const k1r = drdt(state.r);
  const k2r = drdt(state.r + 0.5 * dt * k1r);
  const k3r = drdt(state.r + 0.5 * dt * k2r);
  const k4r = drdt(state.r + dt * k3r);
  const r = state.r + (dt / 6) * (k1r + 2 * k2r + 2 * k3r + k4r);
  // tau integral: use the midpoint rate for a stable, monotone clock
  const tauRate = dtaudt(state.r + 0.5 * dt * k2r);
  return {
    r: Math.max(r, rs),
    t: state.t + dt,
    tau: state.tau + dt * tauRate,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers used by the HUD (kept here so they are testable too)
// ---------------------------------------------------------------------------

/** Human distance: km -> km / AU / ly with sensible precision. */
export function formatDistanceKm(km) {
  if (!Number.isFinite(km)) return 'inf';
  const a = Math.abs(km);
  if (a < 1e5) return `${km.toFixed(a < 100 ? 2 : 0)} km`;
  if (a < 1e8) return `${(km / 1e6).toFixed(2)} million km`;
  if (a < 0.2 * LY_KM) return `${(km / AU_KM).toFixed(2)} AU`;
  return `${(km / LY_KM).toFixed(4)} ly`;
}

/** Seconds -> "HH:MM:SS.mmm" for the twin clocks. */
export function formatClock(seconds) {
  if (!Number.isFinite(seconds)) return '--:--:--.---';
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0')}`;
}

/** Scientific notation with a fixed number of significant digits. */
export function formatSci(value, digits = 3) {
  if (!Number.isFinite(value)) return 'inf';
  if (value === 0) return '0';
  const exp = Math.floor(Math.log10(Math.abs(value)));
  const mant = value / Math.pow(10, exp);
  return `${mant.toFixed(digits - 1)}e${exp >= 0 ? '+' : ''}${exp}`;
}
