/**
 * scripts/webgl-probe.mjs — is a real WebGL2 context available in headless mode?
 *
 * Useful when `npm run test:render` skips itself or the render check cannot get a
 * frame: it prints the browser that was found, the unmasked GL renderer and the
 * precision/format limits the raymarcher cares about (float colour buffers).
 *
 *   node scripts/webgl-probe.mjs
 */

import puppeteer from 'puppeteer-core';
import { BROWSER_ARGS, findBrowser } from './browser.mjs';

const exe = findBrowser();
if (!exe) {
  console.error('no Chromium-family browser found (set EH_BROWSER=/path/to/browser)');
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  args: [...BROWSER_ARGS, '--window-size=1280,720'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('data:text/html,<title>webgl probe</title>');

const info = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  if (!gl) return { webgl2: false };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const floatColor = gl.getExtension('EXT_color_buffer_float');
  return {
    webgl2: true,
    vendor: gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : gl.VENDOR),
    renderer: gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
    version: gl.getParameter(gl.VERSION),
    glsl: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxVaryings: gl.getParameter(gl.MAX_VARYING_VECTORS),
    maxFragUniforms: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS),
    floatColorBuffer: Boolean(floatColor),
    rgba16fRenderable: (() => {
      if (!floatColor) return false;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 8, 8, 0, gl.RGBA, gl.HALF_FLOAT, null);
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return ok;
    })(),
  };
});

console.log(JSON.stringify({ browser: exe, ...info }, null, 2));
await browser.close();
const usable = info.webgl2 && info.floatColorBuffer;
console.log(usable ? '\nOK: WebGL2 with float colour buffers — the simulator will run.' : '\nWARN: missing capability, see README > Troubleshooting');
process.exitCode = usable ? 0 : 2;
