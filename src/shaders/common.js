/**
 * common.js — GLSL helpers shared by every shader in the project.
 * Hashes, value noise / fbm, a blackbody (Planck hue) approximation and the
 * port of physics.js'd disk temperature profile.
 */

export const GLSL_COMMON = /* glsl */ `
// ---------------------------------------------------------------- hashing --
float hash13(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
}

vec3 hash33(vec3 p) {
  p = vec3(
    dot(p, vec3(127.1, 311.7, 74.7)),
    dot(p, vec3(269.5, 183.3, 246.1)),
    dot(p, vec3(113.5, 271.9, 124.6))
  );
  return fract(sin(p) * 43758.5453123);
}

float hash12(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// ------------------------------------------------------------------ noise --
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}

float fbm(vec3 p) {
  float amp = 0.5;
  float sum = 0.0;
  for (int i = 0; i < 4; i++) {
    sum += amp * vnoise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 4.4);
    amp *= 0.5;
  }
  return sum;
}

// ------------------------------------------------------------- blackbodies --
// Tanner Helland's fit of the Planck locus, returned as *linear* RGB with the
// brightest channel normalised to 1 so it only encodes hue, not radiance.
vec3 blackbody(float kelvin) {
  float t = clamp(kelvin, 1200.0, 40000.0) / 100.0;
  float r, g, b;
  if (t < 66.0) r = 1.0;
  else r = 1.292936 * pow(max(t - 60.0, 0.08), -0.1332047592);
  if (t < 66.0) g = 0.3900816 * log(t) - 0.6318414;
  else g = 1.129891 * pow(max(t - 60.0, 0.08), -0.0755148492);
  if (t > 66.0) b = 1.0;
  else if (t < 19.0) b = 0.0;
  else b = 0.5432068 * log(t - 10.0) - 1.196254;
  vec3 c = vec3(clamp(r, 0.0, 1.0), clamp(g, 0.0, 1.0), clamp(b, 0.0, 1.0));
  c = pow(c, vec3(2.2));            // fit is authored in sRGB -> linearise
  return c / max(max(c.r, c.g), max(c.b, c.b));
}

// -------------------------------------------------------------- geometry ---
mat3 rotX(float a) {
  float s = sin(a), c = cos(a);
  return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c);
}

float smoothr(float e0, float e1, float x) {
  float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

// Port of physics.js diskTemperatureProfile(): normalised Shakura-Sunyaev
// profile, peak exactly 1 at r = 9/7 * rIn, zero at and inside the inner edge.
float diskTempProfile(float r, float rIn) {
  float u = r / max(rIn, 1e-3);
  if (u <= 1.0) return 0.0;
  float shape = pow(u, -0.75) * pow(max(1.0 - sqrt(1.0 / u), 0.0), 0.25);
  return clamp(shape * 2.0669, 0.0, 1.0);
}
`;

/** Fullscreen-triangle vertex shader used by every pass. */
export const GLSL_QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
