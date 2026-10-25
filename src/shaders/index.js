/**
 * shaders/index.js — barrel for the GLSL modules.
 */

export { GLSL_COMMON, GLSL_QUAD_VERT } from './common.js';
export {
  BLACK_HOLE_FRAG,
  createBlackHoleMaterial,
  createBlackHoleUniforms,
} from './blackHole.js';
export {
  BRIGHT_FRAG,
  BLUR_FRAG,
  DOWNSAMPLE_FRAG,
  COMPOSITE_FRAG,
  createBrightMaterial,
  createBlurMaterial,
  createDownsampleMaterial,
  createCompositeMaterial,
} from './post.js';
