/**
 * blackHole.js — the main raymarch pass.
 *
 * One fragment shader does everything physical:
 *   1. integrates the null geodesic of a Schwarzschild hole
 *      (d2x/dl2 = -3/2 r_s h^2 x / |x|^5, the exact light-bending equation)
 *   2. accumulates emission + absorption every time the ray crosses the thin
 *      accretion disk plane, so the far side, the lensed top/bottom arcs and
 *      the photon ring all fall out of the integration for free
 *   3. applies relativistic Doppler beaming + gravitational redshift per crossing
 *   4. samples a fully procedural sky (stars + galaxy band) in the *escaped*
 *      direction, which is what makes the sky lens and produce Einstein rings
 *   5. line-integrates the falling probe so it gets lensed, stretched, redshifted
 *
 * Everything works in units of the Schwarzschild radius (r_s === 1).
 */

import * as THREE from 'three';
import { GLSL_COMMON, GLSL_QUAD_VERT } from './common.js';

export const BLACK_HOLE_FRAG = /* glsl */ `
varying vec2 vUv;

uniform vec2  uResolution;
uniform float uTime;          // disk evolution clock (already time-scaled)
uniform vec3  uCamPos;        // r_s units, world frame
uniform vec3  uCamRight;
uniform vec3  uCamUp;
uniform vec3  uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;

uniform float uTilt;          // disk tilt about the world X axis, radians
uniform float uLens;          // lensing strength (1.0 = exact GR)
uniform float uSteps;         // geodesic integration steps actually used

uniform float uDiskInner;
uniform float uDiskOuter;
uniform float uDiskTemp;      // peak colour temperature, K
uniform float uDiskBright;
uniform float uDiskOpacity;
uniform float uShowDisk;

uniform float uPhotonRing;
uniform float uStars;         // starfield on/off
uniform float uStarDensity;
uniform float uGalaxyOn;
uniform float uAlignMag;      // magnitude of the alignment star (Einstein ring demo)
uniform vec3  uAlignDir;      // world frame
uniform float uCamDilation;   // sqrt(1 - r_s/r_cam): finite-observer redshift

uniform vec3  uProbePos;      // r_s units, world frame
uniform vec3  uProbeColor;
uniform float uProbeStretch;
uniform float uProbeAlpha;
uniform float uProbeSize;
uniform float uShowProbe;

const int   MAX_STEPS = 256;
const float RS        = 1.0;
const float R_ESC     = 46.0;
const float GAL_AXIS  = 0.83;
const vec3  GAL_NORMAL = normalize(vec3(0.27, 0.90, -0.34));
const vec3  GAL_CENTER = normalize(vec3(-0.72, 0.30, 0.62));

${GLSL_COMMON}

// ---------------------------------------------------------------- sky ------

vec3 starLayer(vec3 dir, float scale, float density, float gain) {
  vec3 p = dir * scale;
  vec3 cell = floor(p);
  // one hash up front: most cells are empty and bail out immediately
  if (hash13(cell) > density) return vec3(0.0);
  vec3 jit = hash33(cell + 17.13);
  vec3 sp = cell + 0.5 + (jit - 0.5) * 0.62;
  float d = length(p - sp);
  float rad = 0.02 + 0.05 * hash13(cell + 3.71);
  float core = exp(-pow(d / max(rad, 1e-3), 2.0) * 2.0);
  float halo = 0.02 * exp(-pow(d / 0.30, 2.0) * 3.0);
  float mag = pow(hash13(cell + 9.13), 11.0);
  float temp = mix(2700.0, 14500.0, pow(hash13(cell + 5.31), 1.7));
  return blackbody(temp) * (core + halo) * (0.10 + 30.0 * mag) * gain;
}

vec3 skyColor(vec3 dir) {
  vec3 col = vec3(0.0032, 0.0040, 0.0072);   // deep space haze

  float bandMask = 1.0;
  if (uGalaxyOn > 0.5) {
    float b = dot(dir, GAL_NORMAL);
    vec3 q = dir * 2.7;
    float f = fbm(q + GAL_NORMAL * 0.9);
    float dust = fbm(q * 3.3 - f * 0.6);
    float band = exp(-pow(b / 0.27, 2.0));
    float gc = max(dot(dir, GAL_CENTER), 0.0);
    float core = pow(gc, 34.0) * 2.2 + pow(gc, 7.0) * 0.30;
    float lanes = 1.0 - 0.85 * smoothstep(0.40, 0.92, dust);
    vec3 tint = mix(blackbody(3100.0), blackbody(9800.0), smoothstep(0.28, 0.76, f));
    // faint integrated light of unresolved stars: ~1-4% luminance, so the sky
    // stays black and the lensed arcs keep their contrast
    col += tint * band * (0.0035 + 0.030 * f) * lanes;
    col += mix(vec3(1.0, 0.78, 0.52), vec3(0.72, 0.83, 1.0), f) * core * 0.14;
    bandMask = 0.30 + 2.1 * band;
  }

  if (uStars > 0.5) {
    float sd = uStarDensity;
    col += starLayer(dir, 62.0, 0.30 * sd, 1.0) * mix(1.0, bandMask, uGalaxyOn);
    col += starLayer(dir, 27.0, 0.24 * sd, 1.5) * mix(1.0, bandMask, uGalaxyOn);
    col += starLayer(dir, 9.5, 0.16 * sd, 2.6);
  }

  // A deliberately bright star sitting (nearly) behind the hole: when it aligns
  // its light wraps all the way round and you get a full Einstein ring.
  if (uAlignMag > 0.001) {
    float x = max(0.0, 1.0 - dot(dir, uAlignDir));
    float core = exp(-x / 5.0e-5) * 26.0;
    float halo = exp(-x / 2.4e-3) * 1.1;
    col += blackbody(9200.0) * (core + halo) * uAlignMag;
  }

  return col;
}

// --------------------------------------------------------------- disk ------

void diskSample(vec3 hit, vec3 marchDir, out vec3 emission, out float opacity) {
  emission = vec3(0.0);
  opacity = 0.0;

  float rr = length(hit.xz);
  if (rr <= uDiskInner || rr >= uDiskOuter) return;

  float span = max(uDiskOuter - uDiskInner, 1e-3);
  float t = (rr - uDiskInner) / span;
  float env = smoothr(0.0, 0.05, t) * (1.0 - smoothr(0.48, 1.0, t));

  // multi-colour blackbody temperature
  float shape = diskTempProfile(rr, uDiskInner);
  float temp = uDiskTemp * max(shape, 0.03);

  // turbulence: noise painted in a sheared cylindrical frame (differential
  // Keplerian rotation winds the pattern into spiral filaments)
  float ang = atan(hit.z, hit.x);
  float omega = 0.7071 * pow(rr, -1.5);          // sqrt(GM) r^-3/2 with r_s = 1
  float phase = ang + uTime * omega * 5.0;
  vec3 q = vec3(cos(phase), sin(phase), log(rr) * 2.6) * 2.1;
  float n = fbm(q + vec3(0.0, 0.0, uTime * 0.12));
  float filaments = 0.58 + 0.42 * sin(phase * 5.0 + n * 7.0 - log(rr) * 4.5);
  float granules = 0.65 + 0.9 * vnoise(q * 5.5 - uTime * 0.2);
  float dens = (0.30 + 1.5 * n) * filaments * granules;

  // Stefan-Boltzmann-ish radial luminosity (peak-normalised)
  float lum = pow(max(shape, 0.0), 3.0);

  // --- relativistic Doppler beaming -------------------------------------
  // circular orbit speed seen by a local static observer: beta = sqrt(rs/2/(r-rs)).
  // The denominator is floored so a near-extremal inner edge (which can sit at
  // ~0.9 r_s) stays subluminal instead of running away.
  float beta = clamp(sqrt(0.5 / max(rr - 1.0, 0.566)), 0.0, 0.94);
  vec3 orbDir = normalize(vec3(-hit.z, 0.0, hit.x));      // prograde about +y
  vec3 toObs = normalize(-marchDir);                      // we march backwards
  float mu = dot(orbDir, toObs);
  float gam = 1.0 / sqrt(max(1.0 - beta * beta, 1e-4));
  float gD = 1.0 / (gam * (1.0 - beta * mu));             // Doppler factor
  // gravitational redshift r -> camera. r is floored just above the horizon so a
  // near-extremal inner disk stays visible instead of being shifted fully into
  // the infrared (a full Kerr treatment would do exactly that).
  float gG = sqrt(max(1.0 - 1.0 / max(rr, 1.05), 1e-3)) / max(uCamDilation, 0.06);
  float g = clamp(gD * gG, 0.02, 7.0);

  // observed specific intensity scales as g^3 and the spectrum shifts by g.
  // The 0.55 gain keeps the approaching limb inside the filmic shoulder so it
  // stays white-hot instead of flattening to pure white.
  vec3 chroma = blackbody(temp * clamp(g, 0.15, 7.0));
  emission = chroma * lum * pow(g, 3.0) * uDiskBright * env * 0.42;
  emission = min(emission, vec3(22.0));
  opacity = dens * uDiskOpacity * env;
}

// ------------------------------------------------------------- geodesics ---

vec3 accel(vec3 x, float r5, float h2) {
  return -1.5 * uLens * h2 * x / max(r5, 1e-8);
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;

  // world -> disk frame (disk lives on y = 0 there)
  mat3 d2w = rotX(uTilt);
  mat3 w2d = transpose(d2w);

  vec3 roW = uCamPos;
  vec3 rdW = normalize(uCamFwd + uCamRight * (ndc.x * uAspect * uTanHalfFov)
                             + uCamUp   * (ndc.y * uTanHalfFov));

  vec3 x = w2d * roW;
  vec3 v = w2d * rdW;

  vec3 L = cross(x, v);
  float h2 = dot(L, L);                 // conserved: |x x v|^2

  vec3 probe = w2d * uProbePos;
  vec3 probeRad = normalize(probe + vec3(1e-6));

  vec3 acc = vec3(0.0);
  float transmit = 1.0;
  float minR = 1e9;
  bool captured = false;

  for (int i = 0; i < MAX_STEPS; i++) {
    if (float(i) >= uSteps) break;

    float r = length(x);
    minR = min(minR, r);
    if (r < RS) { captured = true; break; }
    if (r > R_ESC && dot(x, v) > 0.0) break;   // flying away: sample the sky
    if (transmit < 0.02) break;                // optically thick disk ahead

    float speed = max(length(v), 0.2);
    // small steps where spacetime is curved, long ones out in flat space
    float dt = clamp(0.085 * r / speed, 0.0035, 1.9);

    float r2 = r * r;
    float r5 = r2 * r2 * r;
    vec3 a1 = accel(x, r5, h2);

    vec3 xn = x + v * dt + 0.5 * a1 * dt * dt;
    float rn = length(xn);
    float rn2 = rn * rn;
    vec3 a2 = accel(xn, rn2 * rn2 * rn, h2);
    vec3 vn = v + 0.5 * (a1 + a2) * dt;

    // --- disk plane crossing -------------------------------------------
    if (uShowDisk > 0.5 && x.y * xn.y < 0.0) {
      float f = x.y / (x.y - xn.y);
      vec3 hit = mix(x, xn, f);
      vec3 em;
      float op;
      diskSample(hit, v, em, op);
      // path length through the slab, longer for grazing cuts — capped so a
      // near-edge-on view stays a crisp ring instead of turning into fog
      float grazing = clamp(1.0 / max(abs(normalize(v).y), 0.2), 1.0, 1.85);
      float path = 0.5 * grazing;
      acc += transmit * em * path;
      transmit *= exp(-op * path * 1.6);
    }

    // --- the probe: analytic blob, so lensing gives it multiple images ----
    // Marching geodesics costs ~0.6 r_s per step out here, far coarser than the
    // probe's own size, so sampling the blob at step centres would light it only
    // by luck. Instead each segment tests its *closest approach* to the probe and
    // accumulates from that: identical brightness at any step budget, and every
    // geodesic branch still produces its own lensed image.
    if (uShowProbe > 0.5 && uProbeAlpha > 0.001) {
      vec3 seg = xn - x;
      vec3 rel = x - probe;                       // segment start relative to it
      vec2 st = vec2(dot(-rel, seg), dot(seg, seg));
      float t = clamp(st.x / max(st.y, 1e-8), 0.0, 1.0);
      vec3 near = rel + seg * t;                // probe -> closest point on segment
      float along = dot(near, probeRad);        // radial: spaghettification axis
      vec3 side = near - probeRad * along;
      float sz = max(uProbeSize, 1e-3);
      float q = (along * along) / (sz * sz * uProbeStretch * uProbeStretch)
              + dot(side, side) / (sz * sz);
      // count it once: only the segment that actually brackets the closest point
      float inSpan = step(1e-4, t) * step(t, 1.0 - 1e-4);
      float halo = exp(-q);                     // shows the tidal stretch
      float core = exp(-q * 8.0);               // makes it read as an object
      acc += transmit * uProbeColor * (halo * 0.3 + core * 1.0) * inSpan * uProbeAlpha;
    }

    x = xn;
    v = vn;
  }

  vec3 col = acc;

  if (!captured) {
    // escaped (or still marching): sample the procedural sky behind the hole
    vec3 dirW = d2w * normalize(v);
    col += skyColor(dirW) * transmit;

    // Photon ring: rays whose closest approach grazes the photon sphere at
    // 1.5 r_s have orbited the hole several times. Physically this is already
    // in the integration above; this term sharpens it into the thin bright rim.
    if (uPhotonRing > 0.0) {
      float dRing = minR - 1.5;
      float ring = exp(-(dRing * dRing) / 0.0026) * uPhotonRing * transmit;
      vec3 diskHue = blackbody(uDiskTemp * 1.15);
      col += mix(vec3(1.0, 0.96, 0.90) * 0.45, diskHue, 0.8 * uShowDisk) * ring;
    }
  }

  // graceful handling of rays that ran out of steps before escaping
  col = max(col, vec3(0.0));
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Uniform bag with sane defaults; scene.js pushes values from the params. */
export function createBlackHoleUniforms() {
  return {
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uCamPos: { value: new THREE.Vector3(0, 2, 12) },
    uCamRight: { value: new THREE.Vector3(1, 0, 0) },
    uCamUp: { value: new THREE.Vector3(0, 1, 0) },
    uCamFwd: { value: new THREE.Vector3(0, 0, -1) },
    uTanHalfFov: { value: Math.tan((50 * Math.PI) / 180 / 2) },
    uAspect: { value: 1 },
    uTilt: { value: 0 },
    uLens: { value: 1 },
    uSteps: { value: 190 },
    uDiskInner: { value: 3 },
    uDiskOuter: { value: 14 },
    uDiskTemp: { value: 7400 },
    uDiskBright: { value: 1.1 },
    uDiskOpacity: { value: 0.55 },
    uShowDisk: { value: 1 },
    uPhotonRing: { value: 1 },
    uStars: { value: 1 },
    uStarDensity: { value: 1 },
    uGalaxyOn: { value: 1 },
    uAlignMag: { value: 1.3 },
    uAlignDir: { value: new THREE.Vector3(0, 0.05, -1) },
    uCamDilation: { value: 1 },
    uProbePos: { value: new THREE.Vector3(9, 0, 0) },
    uProbeColor: { value: new THREE.Color(1, 1, 1) },
    uProbeStretch: { value: 1 },
    uProbeAlpha: { value: 0 },
    uProbeSize: { value: 0.16 },
    uShowProbe: { value: 1 },
  };
}

export function createBlackHoleMaterial(uniforms = createBlackHoleUniforms()) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: GLSL_QUAD_VERT,
    fragmentShader: BLACK_HOLE_FRAG,
    depthTest: false,
    depthWrite: false,
  });
}
