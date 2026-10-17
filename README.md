# web-ocean

A real-time ocean renderer written from scratch on WebGPU, with no engine or rendering library. It draws a sunset sea with simulated waves, whitecaps, sun glitter, and a physically based sky with clouds. You fly around it with a free camera.

![Looking toward the sun from 2.4 m above the water](docs/front.jpg)

| 75 degrees off the sun, 2.4 m up | Looking toward the sun from 30 m up |
|---|---|
| ![](docs/side.jpg) | ![](docs/high.jpg) |

## Run it

You need a recent Chrome with WebGPU and a reasonably capable GPU. On a laptop, force Chrome onto the dedicated GPU in the Windows graphics settings, or it will fall back to the integrated one.

Open `ocean.html` directly in the browser. `ocean.min.html` is the same page minified (61 KB instead of 102 KB). Both are self-contained and work from `file://`.

To run from source:

```
npm install
npm start        # serves http://localhost:8080/
```

After editing anything under `js/`, run `npm run build` to regenerate both bundles. The minified build strips WGSL comments and whitespace and minifies the JavaScript with esbuild.

## Controls

| Input | Action |
|---|---|
| Hold left mouse button and drag | Look around |
| Left and right mouse buttons together | Reset to the default view |
| W A S D | Move |
| Space or E / Q or C, or the mouse wheel | Up / down |
| Shift | 5x movement speed |
| F1 or Settings button | Show the settings panel |
| Esc or the × button | Close the settings panel |
| H | Show or hide the settings panel. General, Clock, Ocean, Sound, and Sky open one at a time, and their groups do the same. |
| M, Sound button, or Sound setting | Toggle procedural ocean audio |

The camera keeps itself above the displaced water surface, so waves never pass through it.

Ocean audio is generated in the browser with the Web Audio API, so there are no sound files
to download. Low swell, surface wash, and crest hiss are mixed from filtered noise. Their
levels follow the simulated water height under the camera, while wind, foam, camera altitude,
and the volume setting shape the result. Swell rumble, surface wash, crest hiss, wave sync, and
stereo width can be adjusted separately. The Sound checkbox, Sound button, and M shortcut all
control the same setting. The Sound and Settings buttons sit together at the top right and use the same surface as the settings panel. General includes the keyboard and mouse shortcuts plus two checkboxes: Onscreen buttons shows the Sound and Settings buttons (on by default), and Onscreen information shows the frame rate, control help, and, during a time lapse, the rendered date, time, and place (off by default).

The Clock overlay is enabled by default for large-screen displays and uses 12-hour time with the date shown unless changed. Its settings control 12/24-hour
time, seconds, date, type style, size, colour, screen position, opacity, and background. It is
independent of Onscreen information, so the controls and diagnostics can be hidden while the
clock remains visible.

The Weather overlay is also enabled by default and uses ZIP code 30265. It shows a graphical current
condition, temperature, feels-like temperature, precipitation amount and probability, humidity,
wind, and the next three hourly precipitation chances. A small timestamp shows when those conditions were last received. Each item can be shown or hidden, units and
screen position are selectable, and the refresh interval defaults to 15 minutes. Active U.S. National
Weather Service alerts appear above the card with a high-contrast warning treatment; severe and
extreme alerts use red. Current conditions come from Open-Meteo, while ZIP locations are resolved
through `api.zippopotam.us`.

Settings are saved in the browser and restored on refresh. A URL parameter overrides the saved value for that visit. Reset to defaults replaces the saved session with the built-in values.

Sky behavior can be Static, Dynamic, Date and time, or Time lapse, and it starts in Dynamic. The ZIP code defaults to 30265. Static mode exposes the sun, moon, lunar phase,
stars, atmosphere, cloud, exposure, and bloom controls. Dynamic and Date and time modes hide the sun position, moon position, phase, and star seed they calculate, and require a five-digit
US ZIP code and resolve and cache its latitude/longitude through `api.zippopotam.us`. Dynamic mode
updates the sun and moon from the current time every 30 seconds. Date and time mode uses the same
place calculation for a date and local time chosen in the settings, and it stays on that moment until
the selection changes. Time lapse uses that same calculation, beginning at January 1, 2026, 12:00 AM unless another start is chosen. The pace is how many minutes of sky time pass each real second. It defaults to 20, so one real second advances the sky by 20 minutes, and the slider runs from 1 to 100. After a full year the sky returns to the chosen start and repeats. When Onscreen information is enabled, the display shows the date, time, and place currently being rendered. These modes turn the view toward the sun and moon's daily arc, so they travel
across the picture instead of passing behind the camera. The moon remains visible while it is above
the horizon, including during daylight. Its phase, the angle of its lit side, and the tilt of its face
come from the configured date, time, and place. It shows the near-side maria and bright craters, faint
earthshine, and reddening near the horizon. The Moon size setting is relative to its true size (1);
the default of 2.5 keeps surface detail visible on a large screen. At night the renderer uses the calculated lunar phase and a location/day-seeded
procedural star field. The remaining appearance controls can still tune clouds, haze, moon brightness, and the night sky.

URL parameters are handy for testing. `?w=2560&h=1440` forces the render resolution, `cam=x,y,z,yawDeg,pitchDeg` sets the camera, `fov=deg` sets the field of view, `ui=0` hides the HUD and buttons, and any settings key works too, for example `windSpeed=12&swellHs=2&sunElev=8`.

Export in the settings panel downloads the current settings as `ocean-settings.json`. Import reads that file back, applies the recognized values, and leaves every other setting unchanged. `sound`, `showButtons`, and `showInfo` accept `true` or `false`. Reset to defaults restores every setting and the camera to their built-in defaults, with sound off.

## How it works

### Waves

The sea is a Tessendorf FFT simulation with six cascades of 256 by 256 samples. The patches range from 1103 m down to 0.26 m, so wavelengths run from about a kilometre to a few millimetres. The smallest cascade produces the sharp sun sparkles near the camera.

The spectrum is a fetch-limited JONSWAP wind sea with Donelan-Banner directional spreading, plus a narrow long-crested swell. Dispersion includes the capillary term, and choppy horizontal displacement sharpens the crests. The inverse FFTs are radix-2 compute shaders working in workgroup memory.

The surface mesh is a CDLOD quadtree with 17 levels. Vertices are 6.25 cm apart near the camera and the mesh reaches 160 km, with continuous vertex morphing between levels.

### Shading

- Mip-mapped first and second moments of the wave slopes (LEAN mapping) give the right anisotropic roughness at every distance. The sun glitter widens with distance and the far sea settles into a sheen without aliasing. Screen-space slope derivatives add specular anti-aliasing.
- Sun glitter uses an anisotropic Gaussian slope distribution with Smith masking and the size of the solar disc.
- The sky reflection comes from an environment cube map rebuilt every frame, with roughness-filtered mips. At grazing angles the reflection direction is tilted to account for which wave facets the viewer can actually see.
- The water body is turbid blue-green, lit by the whole sky hemisphere. Backlit crests get a subsurface glow, and wind-gust patches modulate the short ripples.
- Whitecaps start where the total surface Jacobian folds. Foam is stored in two camera-centred world-space maps (128 m and 1 km wide), decays over time, drifts downwind, and breaks into streaks as it ages. A procedural bubble texture gives it its structure.

### Sky

The atmosphere follows Hillaire's approach, with transmittance, multiple-scattering, and sky-view lookup tables plus aerosol haze. There are two independently advected cloud layers: broken low cumulus and a fibrous high deck. Each has its own wind direction, speed, altitude, scale, coverage, and optical density. Shape evolution continuously changes the formations instead of merely sliding a fixed texture across the sky. Shared controls tune edge softness, silver linings, ambient light, and whether motion runs. Cloud behavior starts in Dynamic: coverage, altitude, wind, density, and lighting follow the time of day and a slowly changing weather pattern. Low clouds build through the afternoon and thin at night, while the high deck moves faster and changes on its own. The manual cloud controls are hidden while Dynamic is selected, and their previous values return when Static is selected again.

Cloud lighting follows the configured sun throughout the day, producing warm sunrise and sunset transmission, bright backlit edges, self-shadowed interiors, and cooler ambient bases. After dark, the moon gives nearby cloud edges faint cool illumination. A procedural celestial pass adds a phased moon and stable, seeded stars after twilight.

Cloud noise octaves are filtered by pixel footprint, and silhouettes are anti-aliased analytically: the screen-space derivative of each layer's edge function sets the width of its opacity edge. Cloud transmittance along the sun direction dims the sunlight that reaches the water, and aerial perspective is applied over the sea.

### Post-processing

The scene renders in HDR with 4x MSAA. Post-processing adds an 8-level bloom, AgX tone mapping, a slight white balance shift, and dithering.

## Performance

At 2560 by 1440 on an RTX 5070 Ti, the GPU takes about 6 to 8 ms per frame, measured while other programs were also using the GPU. The HUD shows FPS and GPU time when the browser supports `timestamp-query`.

The per-frame code reuses preallocated typed arrays and descriptors, so the garbage collector has almost nothing to do. The only recurring allocations are the objects WebGPU itself requires, such as the swap-chain view and command buffers.

## Known limitations

- Far water is still somewhat darker than the bright horizon sky above it.
- The water is tuned toward turbid coastal water. The "Water turbidity" slider gives darker, bluer deep water when turned down.
- The scene is open ocean only. There is no shoreline, surf, or objects in the water.
- Clouds are two flat layers, not volumetric.

## How it was made

I built this with Claude Code (Opus 5.5). I asked for the most realistic water it could produce, in WebGPU, with a floating camera, and left the architecture and implementation to it. It checked its own work by rendering screenshots in headless Chrome and having separate critic subagents review them, so it was not grading its own output. I gave feedback along the way, mainly on the clouds, which led to replacing the volumetric clouds with the flat layers and later fixing their edge aliasing.

## Repository layout

| Path | Contents |
|---|---|
| `index.html` | Page shell, HUD, and settings panel styles |
| `js/main.js` | Device setup, resources, camera, per-frame loop |
| `js/wgsl/` | Shaders as JavaScript modules: `sim.js` (waves and foam), `sky.js` (atmosphere and clouds), `ocean.js` (surface and sky pass), `post.js` (bloom and tone mapping), `common.js` (shared structs) |
| `server.mjs` | Tiny static server for development |
| `build.mjs` | Builds `ocean.html` and `ocean.min.html` |
| `docs/` | README images |

## License

MIT. See [LICENSE](LICENSE).
