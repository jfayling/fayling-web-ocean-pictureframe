# Promo videos

This folder produces two 30-second promo videos for the app, plus a thumbnail for each. Every frame of ocean, sky, rain, and lightning comes from the app itself, running in Chrome on a real GPU. The sound in the videos is the app's own procedural audio, rendered by its Web Audio graph during the same capture.

| Output | Size | Frame rate | Codec |
|---|---|---|---|
| `videos/ocean-launch-landscape.mp4` | 1920×1080 | 60 fps | H.264 High, yuv420p, AAC 192 kb/s stereo 48 kHz |
| `videos/ocean-launch-vertical.mp4` | 1080×1920 | 30 fps | H.264 High, yuv420p, AAC 192 kb/s stereo 48 kHz |
| `videos/ocean-thumbnail-landscape.jpg` | 1920×1080 | | JPEG |
| `videos/ocean-thumbnail-vertical.jpg` | 1080×1920 | | JPEG |

The pipeline is separate from the app. It has its own `package.json`, it loads the app through the repository's existing `server.mjs`, and it changes nothing in `js/`, `index.html`, or the standalone builds. The rendered MP4s and everything under `build/` are listed in the repository `.gitignore`, so they are never committed by accident.

## Requirements

- Node.js 20 or newer.
- Google Chrome or Microsoft Edge with WebGPU on a hardware GPU. Set `CHROME_PATH` if the browser is not installed in the usual place. The capture refuses to run on a software adapter (SwiftShader, WARP, llvmpipe) or on a fallback adapter.
- Roughly 3 GB of free disk space for intermediates.
- ffmpeg and ffprobe come from the `ffmpeg-static` and `ffprobe-static` packages. To use your own builds, set `FFMPEG_PATH` and `FFPROBE_PATH`.

```bash
cd marketing
npm install
npm run probe        # prints the WebGPU adapter Chrome will use
npm run produce      # capture -> titles -> compose -> thumbnails -> validate
```

`npm run produce` takes about 13 minutes on an RTX A5000 from a clean `build/` folder: about 10 minutes of capture and 3 minutes for the rest. `node scripts/produce.mjs --skip-capture` reuses the existing clips. Each step can also be run on its own, and each accepts `--format landscape` or `--format vertical`:

| Command | What it does | Output |
|---|---|---|
| `npm run capture` | Records each scene from the running app. Scenes whose settings have not changed since the last capture are skipped; `--force` recaptures them. `--scene storm` limits the run to one scene. | `build/clips/<format>/<scene>.mp4`, `.wav`, `.json` |
| `node scripts/capture.mjs --scene storm --stills 0.5,2,3.5` | Saves stills at chosen times instead of a clip, for framing a shot. | `build/stills/<format>/` |
| `npm run titles` | Renders the captions as transparent PNG frames in a browser page. `--preview 1,3,7` writes a few frames to `build/review/` for checking. | `build/titles/<format>/` |
| `npm run compose` | Cross-dissolves the scene clips, overlays the captions, mixes and loudness-normalizes the audio, and encodes the final MP4. | `videos/*.mp4` |
| `npm run thumbnails` | Takes a real frame from the hook clip and sets the thumbnail type over it. | `videos/*.jpg` |
| `npm run validate` | Checks both videos with ffprobe and ffmpeg filters, and writes a review contact sheet. Exits with code 1 when a check fails. | `build/validation.json`, `build/review/<format>-final-sheet.jpg` |
| `node scripts/contact-sheet.mjs --clip build/clips/landscape/storm.mp4 --at 0.5,1,2` | Tiles frames from any clip into one image. | `build/review/` |

## How the footage is captured

A normal screen recording of a WebGPU page drops frames and is tied to wall-clock time. To avoid that, the capture drives the app frame by frame:

1. `scripts/capture.mjs` starts the repository's `server.mjs` and launches Chrome through `playwright-core`. Chrome runs headless, but WebGPU still uses the hardware adapter. The page loads from `localhost` because WebGPU requires a secure context.
2. Before any app code runs, `scripts/lib/page-harness.js` replaces the page's clock. It takes over `requestAnimationFrame`, `performance.now()`, and `Date`. Each output frame advances time by exactly 1/60 s (or 1/30 s for vertical), then waits for the GPU queue to finish before the frame is read back. Rendering can take as long as it needs, and the video still plays at the real speed with no dropped or duplicated frames.
3. `Math.random` is seeded, so rain streaks, lightning timing, and the sound are the same on every run with the same config.
4. The app's audio context is replaced with an `OfflineAudioContext` that is advanced in step with the video frames. The app builds its real ocean, wind, rain, and thunder graph and is unaware of the difference. The capture saves the result as a WAV for each scene. The sample rate is 46,080 Hz, so one video frame is a whole number of 128-sample audio blocks at both 30 and 60 fps. The compose step resamples to 48 kHz.
5. The camera, sky, and weather are set through the app's own URL parameters (`w`, `h`, `cam`, `fov`, `ui=0`, and any setting key). Changes during a shot, such as wind rising or rain getting heavier, move the app's own settings sliders a little every frame. Camera pans use the app's drag-to-look, and forward motion holds the W key.
6. Each frame is read with the Chrome DevTools `Page.captureScreenshot` command, without browser chrome, cursor, or settings panel, and piped to ffmpeg as a high-quality intermediate (x264 CRF 12).
7. The picture-frame scene shows the app's clock, compass, and weather widgets. Its weather and place-name requests go to Open-Meteo and zippopotam.us. The first capture saves those responses to `fixtures/net/`, and later captures replay them, so the widgets read the same on every run. Set `capture.network` to `live` to always fetch fresh data, or to `replay` to fail when a recording is missing. The UI is scaled by `uiScale` (like a TV's display scaling), so the widgets stay readable while the 3D view still renders at the full 1920×1080.

Captions are rendered by `scripts/templates/titles.html` in a browser page with a transparent background. The page measures the text, breaks lines only where the config has a `\n`, and shrinks any line that would leave the safe area. The video is assembled in ffmpeg: `xfade` dissolves between scenes, `overlay` adds the captions, and `acrossfade` blends the audio. The mix is normalized in two passes to −16 LUFS integrated with a −1.5 dBTP true-peak ceiling, then encoded to AAC. The limiter aims 0.6 dB lower (`audio.codecHeadroom`) because AAC encoding raises peaks slightly.

## Storyboard

All scenes are defined in `video-config.json`. Every scene clip carries 0.5 s of extra footage, so it can dissolve into the next scene without shortening the cut.

| Time | Scene | What the app is showing | Caption |
|---|---|---|---|
| 0–4 s | `hook` | Low sun on the horizon, camera gliding forward over the swell | THIS ISN'T OCEAN FOOTAGE. / IT'S WEBGPU. |
| 4–6.75 s | `waves-close` | Close to the water while the wind rises from 9 to 13 m/s | REAL-TIME OCEAN SIMULATION / GPU waves • Reflections • Whitecaps |
| 6.75–9.5 s | `waves-wide` | Higher camera over a long, heavy swell with whitecaps | (continues) |
| 9.5–16.5 s | `sky` | The app's time-lapse mode at 20 sky-minutes per second, starting from sunset on 14 November 2026 at Newnan, Georgia, through dusk until the crescent moon and stars appear. Exposure rises as the sky darkens, and the camera pans toward the moon. | A LIVING SKY / Sun • Moon • 8,404 stars |
| 16.5–18.25 s | `calm` | Overcast sky, calm sea | DYNAMIC WEATHER / Rain • Lightning • Storms |
| 18.25–22.5 s | `storm` | Dusk thunderstorm with the app's rain, lightning, and thunder. Rain increases from 35% to 90% and wind from 10 to 16 m/s. | (continues) |
| 22.5–26.5 s | `frame` | Dynamic sky at 5:39 PM on 16 November 2026, just after sunset, with the clock, compass, and live-weather widgets | YOUR OCEAN. YOUR SCREEN. / Clock • Weather • Ambient Sound |
| 26.5–30 s | `cta` | Moonlit night sea | FREE & OPEN SOURCE → RUNS IN YOUR BROWSER → github.com/jfayling/fayling-web-ocean-pictureframe |

### Vertical version

The vertical video is captured separately at 1080×1920. The app renders a true portrait view with a wider field of view; nothing is cropped or stretched from the landscape footage. Captions use their own sizes and line breaks, within about 6% side margins and away from the bottom quarter, where phone apps place their own controls. The one exception is the `frame` scene: the picture-frame widgets are laid out for a TV, so the vertical video shows the landscape capture as a sharp 16:9 inset over a blurred, darkened fill of the same footage (`"layout": "blur-fit"`).

## Changing the videos

Edit `video-config.json`, then run `npm run produce`. Only scenes whose settings changed are recaptured.

- **Scene timing:** each scene's `duration`. The durations must add up to `video.duration`.
- **App settings:** `app` takes any key the app accepts as a URL parameter (see the main README). `app.defaults` applies to every scene.
- **Camera:** `position` [x, y, z] in metres, `yaw` and `pitch` in degrees, `fov`. `hold: ["KeyW"]` moves forward. `pan: { "x": -1, "end": 4 }` drags the view by whole pixels per frame until the given time. Chrome rounds mouse movement to whole pixels, and a negative `x` turns east.
- **Gradual changes:** `ramps: [{ "key": "windSpeed", "from": 9, "to": 13, "start": 0, "end": 3 }]` moves a settings slider with eased interpolation.
- **Per-format overrides:** `formats.vertical` / `formats.landscape` inside a scene or a caption.
- **Captions:** `titles` per scene with `style` (`headline`, `reveal`, `sub`, `kicker`, `url`), `in`/`out` times relative to the scene, an optional `color`, and an optional `scrim` (darkness from 0 to 1 behind the text, for bright skies). Text sizes and caption height are set per format under `titles`.
- **Randomness:** `capture.seed`, or a scene-level `seed`. The storm uses seed 7 because it places lightning strikes well inside the shot.

## Audio and licensing

- The soundtrack is the app's procedural audio (ocean surf, wind, rain, thunder), rendered by the app's own Web Audio code during capture. Nothing is added except crossfades between scenes, loudness normalization, and a short fade in and out.
- The optional music track `media/track001.mp3` is **not** used. It was generated with Suno and is not covered by the MIT license, and its redistribution in promotional videos has not been verified. `music=false` is set for every scene.
- All imagery is the app's renderer. No stock footage, generated images, or painted-on effects are used. The thumbnails are frames from the captured clips with type on top.
- The weather fixtures in `fixtures/net/` contain public forecast data from Open-Meteo and zippopotam.us, recorded on 16 November 2026.
- The renderer comes from [Noniv/web-ocean](https://github.com/Noniv/web-ocean) by Maksymilian Dendura, under the MIT license, as described in the main README.

## Known limitations

- **Headless browser.** Footage is captured in headless Chrome with a hardware GPU adapter. The image matches what a desktop browser renders, but it is not a recording of a physical display.
- **Hurricane look omitted.** At full intensity, the app's hurricane rain style looked like snow at 1080p, so the storm scene uses the thunderstorm style instead.
- **Lightning as the app draws it.** The app's sky shader builds each bolt from 46 jagged horizontal steps plus one branch (`rainBolt` in `js/wgsl/rain.js`). Paused on a single frame, a bolt therefore looks like a stepped, banded column, and at the flash peak the sea lights up almost white. Both are left exactly as rendered; each strike lasts only a few frames.
- **File size.** The videos are encoded as masters at CRF 17, which comes to about 70 MB for each 30-second file, mostly because rain and whitecaps are hard to compress. Raise `video.crf` (for example to 21) for smaller files.
- **Fixed sky dates.** The time lapse starts on 14 November 2026 because the app's simulated rain begins on the evening of the 16th, which hid the moon and stars.
- **Exposure ramp.** The `sky` scene raises the app's exposure setting as night falls, much as a camera would, so the stars stay visible on phone screens.
- **Replayed weather.** The picture-frame scene shows recorded weather for Newnan, Georgia (ZIP 30265), not live conditions at playback time.
- **Fonts.** Captions use Inter if it is installed and otherwise fall back to Segoe UI Variable or Segoe UI. Install Inter for identical type on another machine.
- **Speed.** Capture runs at about 7 to 8 frames per second at 1080p on an RTX A5000, mostly spent reading frames back from the GPU.
