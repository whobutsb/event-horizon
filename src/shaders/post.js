/**
 * post.js — hand-rolled post chain: bright pass -> separable gaussian bloom
 * pyramid -> composite (radial star streaks, chromatic aberration, ACES filmic,
 * vignette, film grain, dither). No external assets, no EffectComposer.
 */

import * as THREE from 'three';
import { GLSL_COMMON, GLSL_QUAD_VERT } from './common.js';

export const BRIGHT_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uKnee;
void main() {
  vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  float luma = max(max(c.r, c.g), c.b);
  float soft = max(luma - uThreshold + uKnee, 0.0);
  float w = clamp(soft / max(2.0 * uKnee, 1e-4), 0.0, 1.0);
  gl_FragColor = vec4(c * w, 1.0);
}
`;

export const BLUR_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uDirection;   // texel-sized step, already includes radius
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 0.227027;
  c += (texture2D(tSrc, vUv + uDirection * 1.3846).rgb + texture2D(tSrc, vUv - uDirection * 1.3846).rgb) * 0.316216;
  c += (texture2D(tSrc, vUv + uDirection * 3.2307).rgb + texture2D(tSrc, vUv - uDirection * 3.2307).rgb) * 0.070270;
  gl_FragColor = vec4(c, 1.0);
}
`;

export const DOWNSAMPLE_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
void main() {
  vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  gl_FragColor = vec4(c * 0.25, 1.0);
}
`;

export const COMPOSITE_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tBloomA;
uniform sampler2D tBloomB;
uniform vec2 uResolution;
uniform float uAspect;
uniform float uExposure;
uniform float uBloomStrength;
uniform float uBloomBWeight;   // 0 when the wide bloom level is skipped
uniform float uGrain;
uniform float uTime;
uniform float uStretch;        // 0..1 : radial star streaking near the horizon
uniform vec2  uShadowCenter;   // screen-space position of the hole
uniform float uShadowRadius;   // in uv units (y-normalised)
uniform float uChroma;
${GLSL_COMMON}

vec3 fetchCA(vec2 uv, vec2 caOffset) {
  float r = texture2D(tScene, uv + caOffset).r;
  float g = texture2D(tScene, uv).g;
  float b = texture2D(tScene, uv - caOffset).b;
  return vec3(r, g, b);
}

vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 uv = vUv;
  vec2 fromCenter = (uv - uShadowCenter) * vec2(uAspect, 1.0);
  float dist = length(fromCenter);
  vec2 radial = fromCenter / max(dist, 1e-5);

  // chromatic aberration grows towards the frame edge
  vec2 caOffset = radial * uChroma * 0.0035 * (0.25 + dist) / vec2(uAspect, 1.0);

  vec3 col = fetchCA(uv, caOffset);

  // --- star streaking: as the ship nears the horizon the sky smears radially
  if (uStretch > 0.002 && dist > uShadowRadius * 0.75) {
    float mask = smoothstep(uShadowRadius * 0.75, uShadowRadius * 1.6 + 0.05, dist);
    vec2 step = radial / vec2(uAspect, 1.0) * (uStretch * 0.030 * mask);
    vec3 sum = col;
    float wsum = 1.0;
    for (int i = 1; i < 5; i++) {
      float fi = float(i);
      float w = 1.0 - fi * 0.16;
      sum += fetchCA(uv - step * fi, caOffset) * w;
      wsum += w;
    }
    col = mix(col, sum / wsum, clamp(uStretch * 1.4, 0.0, 1.0));
  }

  vec3 bloom = texture2D(tBloomA, uv).rgb * 0.30
             + texture2D(tBloomB, uv).rgb * 0.26 * uBloomBWeight;
  col += bloom * uBloomStrength;

  col *= uExposure;
  col = aces(col);

  // vignette
  float vig = smoothstep(1.35, 0.32, length((uv - 0.5) * vec2(uAspect, 1.0)));
  col *= mix(1.0, vig, 0.5);

  // film grain + dither (both animated, hash based, no texture needed)
  float g = hash12(gl_FragCoord.xy + fract(uTime) * vec2(41.3, 17.9));
  col *= 1.0 + (g - 0.5) * uGrain * 0.42;
  col += (hash12(gl_FragCoord.yx * 1.7 - fract(uTime) * vec2(23.1, 61.7)) - 0.5) / 255.0;

  gl_FragColor = vec4(toSRGB(max(col, vec3(0.0))), 1.0);
}
`;

function mat(fragmentShader, uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: GLSL_QUAD_VERT,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
}

export function createBrightMaterial() {
  return mat(BRIGHT_FRAG, {
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2(1, 1) },
    uThreshold: { value: 3.0 },
    uKnee: { value: 1.2 },
  });
}

export function createBlurMaterial() {
  return mat(BLUR_FRAG, {
    tSrc: { value: null },
    uDirection: { value: new THREE.Vector2(0, 0) },
  });
}

export function createDownsampleMaterial() {
  return mat(DOWNSAMPLE_FRAG, {
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2(1, 1) },
  });
}

export function createCompositeMaterial() {
  return mat(COMPOSITE_FRAG, {
    tScene: { value: null },
    tBloomA: { value: null },
    tBloomB: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uAspect: { value: 1 },
    uExposure: { value: 1 },
    uBloomStrength: { value: 0.85 },
    uBloomBWeight: { value: 1 },
    uGrain: { value: 0.35 },
    uTime: { value: 0 },
    uStretch: { value: 0 },
    uShadowCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uShadowRadius: { value: 0.1 },
    uChroma: { value: 0.6 },
  });
}
