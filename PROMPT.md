# PROMPT.md — the brief that produced this project

This repository was built end-to-end by a **local LLM agent**, with no human-written code. The
original instruction is reproduced verbatim below.

## Run metadata

| | |
| --- | --- |
| Model | `Qwen3.8-Flash-Next-GGUF` (quantized, served locally) |
| Provider | Unsloth Studio (`unsloth` provider), local inference — no cloud API |
| Reasoning effort | **high** |
| Harness | [`pi`](https://github.com/badlogic/pi-mono) coding agent |
| Session | `01a174fb-060f-75af-8cd7-3a78a17efa6f`, 2026‑10‑25 21:32 → 22:51 UTC |
| Wall-clock build time | **≈ 1 h 18 m** total agent time (see breakdown below) |
| Tool calls | ≈160 (`bash` ~90 · `edit` 30 · `write` 24 · `read` ~17) |
| Human turns | 4 — the brief, plus "stop", "continue" and this README request |
| Hardware | Apple silicon (M-series Ultra), Metal via ANGLE for the headless GPU checks |

### Where the time went

| Phase | Elapsed | Tool calls | What happened |
| --- | --- | --- | --- |
| 1. Prompt → working app | ~54 min | 97 | Scaffold Vite + Three.js, physics module, presets, camera rig, probe ODE, geodesic raymarcher, post chain, HUD/panel, unit tests to green, production build, headless-Chrome render verification with screenshots, exposure/bloom tuning |
| 2. Post-compaction hardening | ~24 min | 62 | Validated the shader's discrete integrator against the analytic escape cone in an independent JS replica, diagnosed the "black frame near the horizon" as correct physics and fixed it as UX (auto lens widening + pan), added quality/camera and browser render test suites, fixed 3 real bugs those tests surfaced, README, tooling |

Roughly a third of the wall clock is machine time rather than model time: booting headless WebGL2
contexts and reading 1440×900 float framebuffers back for every render assertion.

## The prompt (verbatim)

```text
Build "Event Horizon", an interactive real-time black hole simulator in Three.js with Vite. It must
run at 60 fps in a desktop browser and use no external assets: every texture, star and effect is
procedural.

The scene:

- A Schwarzschild black hole with a glowing, turbulent accretion disk, rendered with a raymarching
  fragment shader that bends light. The far side of the disk must appear above and below the shadow,
  as in Interstellar.

- Relativistic Doppler beaming: one side of the disk is brighter and bluer, the other dimmer and
  redder.

- A procedural starfield and galaxy band behind it that visibly lenses around the black hole,
  including an Einstein ring when a star aligns.

- A photon ring at the shadow's edge, plus bloom and film grain post-processing.

Interaction:

- Orbit, zoom and fly-in camera. Flying toward the horizon slows time on an on-screen clock and
  stretches the stars.

- A control panel for mass, spin, disk temperature, disk tilt, lensing strength and time scale, with
  presets "Gargantua", "Sagittarius A*" and "Quiet".

- A "drop a probe" button: a small ship falls in, stretches, redshifts and freezes at the horizon
  from the viewer's point of view.

- A cinematic mode that flies a slow, scripted camera path, for recording.

Quality:

- A clean, minimal sci-fi HUD with live readouts: mass, Schwarzschild radius, the probe's time
  dilation factor and fps.

- Automatic quality scaling if fps drops below 50.

- Split the code into modules: scene, shaders, physics, ui, camera.

- Write tests for the physics math (Schwarzschild radius, time dilation, Doppler factor) and the
  presets, plus a production build that passes.

- Write a README with how to run it and the physics behind each effect.

When you finish, run the tests and the build, open it in a browser to check it renders, and report
what works.
```

### Follow-up instructions (verbatim)

```text
stop at next turn so we can compact
continue
let's update the readme to include this is a local llm experiment using the current model on high,
enter the estimated time to build, and add a new file called PROMPT.md that includes the prompt of
what was built
```

## Notes on how it was built

* Nothing was accepted on assertion — every claim in the README is backed by either a unit test or an
  assertion on pixels read back out of a real GPU framebuffer (`tests/render.browser.test.js`,
  `scripts/render-check.mjs`).
* Two "bugs" turned out to be correct general relativity and were kept: the fully black frame inside
  ~2.7 r_s, and the probe never visibly crossing the horizon. Both are explained in the README.
* The agent wrote its own numerical validation harness on the fly (a JS replica of the shader's
  velocity-Verlet loop) rather than trusting that the render "looked right".
