# Contributing to Ocean Picture Frame

Thanks for helping. Bug reports, ideas, documentation fixes, and pull requests are all welcome.

## Ground rules

- **Keep it self-contained.** The app ships as one HTML file that runs from `file://`. Do not add runtime dependencies, CDN scripts, or asset files the bundle cannot inline. Network access is only for live data such as weather.
- **Keep the renderer intact.** The wave simulation, shading, atmosphere, and post-processing come from [Noniv/web-ocean](https://github.com/Noniv/web-ocean). Changes there are welcome, but describe the visual effect and include before and after screenshots.
- **Keep the license and attribution.** The project is MIT licensed with Maksymilian Dendura's copyright notice. Do not remove it.
- **Use real captures.** Screenshots and recordings in issues, pull requests, and docs should come from the running app.

## Development loop

Requirements: Node.js 18 or later and a browser with WebGPU (see [docs/BROWSER_SUPPORT.md](docs/BROWSER_SUPPORT.md)).

```
npm ci            # install esbuild, the only dev dependency
npm start         # http://localhost:8080/ serves index.html and js/ as ES modules
```

Edit `index.html` and the files under `js/`, then reload the page. Shaders live in `js/wgsl/` as JavaScript template strings.

Before you open a pull request:

```
npm run build     # regenerate ocean.html and ocean.min.html
npm run check     # bundles are self-contained, docs have no broken local links
```

Commit the regenerated `ocean.html` and `ocean.min.html` together with your source change. CI rebuilds them and fails if the committed copies are stale.

Then open `ocean.html` straight from disk to confirm the standalone build still works from `file://`.

## Testing visual changes

The project has no automated rendering tests. Check changes by eye in the browser, and use these helpers:

- **URL parameters** override any setting for one visit, for example `?skyMode=static&sunElev=4&windSpeed=12`. `?w=1600&h=900` fixes the render resolution, and `cam=x,y,z,yawDeg,pitchDeg` fixes the camera.
- **Deterministic captures.** With `npm start` running, `?shot=name.png&w=1600&h=900&frames=240` renders 240 frames at a fixed time step and saves the canvas to `shots/name.png` (ignored by git). Add `seq=N` for a sequence. The page title changes to `SHOT DONE` when it finishes. Captures contain the 3D view only, without the HTML widgets.
- **Onscreen information** in Settings → General shows the frame rate and GPU time when the adapter supports `timestamp-query`.

For a visual change, attach a before and after capture to the pull request, taken with the same URL parameters.

## Reporting bugs

Use the [bug report form](https://github.com/jfayling/fayling-web-ocean-pictureframe/issues/new?template=bug_report.yml). For rendering and startup problems, the browser version, operating system, GPU, and driver version usually decide the cause, so please include them, plus anything shown in the error overlay or the browser console.

## Suggesting features

Use the [feature request form](https://github.com/jfayling/fayling-web-ocean-pictureframe/issues/new?template=feature_request.yml). Ideas that suit a picture frame on a television, such as new widgets, weather behavior, or sky phenomena, fit the project best.

## Code style

Match the surrounding code: ES modules, two-space indentation, `const` by default, and short comments only where the code cannot speak for itself. The per-frame loop avoids allocations; reuse the preallocated typed arrays and descriptors there.
