# Changelog

## v1.0.0 — first release

The first tagged release of Ocean Picture Frame: a real-time WebGPU ocean for a television or monitor, built on [Noniv/web-ocean](https://github.com/Noniv/web-ocean) by Maksymilian Dendura.

### Downloads

| File | What it is |
|---|---|
| `ocean.html` | The whole app in one readable HTML file. Open it from disk; no server or install needed. |
| `ocean.min.html` | The same app, minified. |
| `track001.mp3` | Optional background music. Put it in a `media` folder next to the HTML file. |

Or run it in the browser: [live demo](https://jfayling.github.io/fayling-web-ocean-pictureframe/app/).

### Highlights

- **Ocean** from web-ocean: a Tessendorf FFT sea with six cascades, whitecaps and drifting foam, and glitter paths that stay sharp up close and settle into a sheen at the horizon.
- **A real sky.** The sun and moon follow any location live, at a chosen date and time, or as a time lapse. The moon is phased, and 8,404 stars from the Yale Bright Star Catalogue rise and set with sidereal time and twinkle near the horizon.
- **Weather.** Live conditions and a three-hour forecast from Open-Meteo, U.S. National Weather Service alerts, and rain, thunderstorms with lightning, and hurricanes on the water. Rain can follow the live weather.
- **Sound.** Procedural ocean sound from the Web Audio API that follows the waves under the camera, procedural rain and thunder timed to the lightning distance, and optional music.
- **Picture-frame widgets.** A clock, compass, and weather card, each movable and restyleable.
- **Settings** saved in the browser, with JSON export and import and shareable configuration links.
- **Television-friendly.** Diagnostics are off by default, `?ui=0` hides the buttons, and Picture quality can trade resolution for frame rate.

### Requirements

A desktop browser with WebGPU: Chrome or Edge 113 or later on Windows, macOS, or ChromeOS. Other browsers and platforms vary. See [docs/BROWSER_SUPPORT.md](docs/BROWSER_SUPPORT.md) for the support table and troubleshooting.

### Project

- GitHub Pages site with a landing page, the live app at `/app/`, and a 60-second time lapse with sound
- CI that rebuilds the standalone bundles, checks they are committed and self-contained, and checks the documentation links
- Contributing guide, issue forms, and a pull request template

MIT licensed. Copyright (c) 2026 Maksymilian Dendura.
