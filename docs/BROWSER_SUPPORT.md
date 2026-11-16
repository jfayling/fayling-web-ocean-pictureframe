# Browser support and troubleshooting

Ocean Picture Frame renders with [WebGPU](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API). There is no WebGL fallback, so the browser has to give the page a WebGPU device.

## Supported browsers

| Browser | Status |
|---|---|
| Chrome and Edge 113 or later on Windows, macOS, and ChromeOS | Supported. This is the configuration the project is developed and tested on. |
| Chrome and Edge on Linux | WebGPU support depends on the browser version, the GPU driver, and flags. Try `chrome://flags/#enable-unsafe-webgpu` and `--enable-features=Vulkan` if `navigator.gpu` is missing. |
| Chrome on Android | WebGPU is available on recent versions and devices. The renderer is tuned for desktop GPUs and large screens, so expect low frame rates on phones. |
| Safari | WebGPU availability depends on the Safari version. Not tested by this project. |
| Firefox | WebGPU availability depends on the Firefox version and platform. Not tested by this project. |

The [GitHub Pages landing page](https://jfayling.github.io/fayling-web-ocean-pictureframe/) reports whether WebGPU is available in the current browser before you launch the app. The [time lapse](https://jfayling.github.io/fayling-web-ocean-pictureframe/#timelapse) plays in any browser that supports MP4 video.

The renderer uses `timestamp-query` when the adapter offers it, to show GPU time in the HUD. It runs without it.

## Hardware

The renderer runs six 256×256 FFT cascades, a 17-level CDLOD mesh, a per-frame environment cube map, and 4× MSAA in HDR. A discrete GPU or a recent integrated GPU is recommended. On a laptop with two GPUs, make sure the browser uses the dedicated one.

If the frame rate is low, set Settings → General → **Picture quality** to Balanced (75%) or Efficient (50%), or force a render resolution with `?w=1920&h=1080`. The default, Auto, adjusts the resolution to hold the frame rate.

## Troubleshooting

### The page shows an error instead of the ocean

The error overlay appears when the page cannot get a WebGPU adapter or device, or when initialization fails. "WebGPU is not available in this browser" means `navigator.gpu` is missing. "No WebGPU adapter found" means WebGPU exists but no usable GPU was offered. In order:

1. **Update the browser.** Use the current Chrome or Edge.
2. **Turn on hardware acceleration.** In Chrome: Settings → System → "Use graphics acceleration when available", then restart the browser.
3. **Check `chrome://gpu`.** The "WebGPU" line should read "Hardware accelerated". If it says "Disabled", the GPU or driver may be blocklisted. Update the GPU driver from the vendor's site.
4. **Select the dedicated GPU.** On Windows: Settings → System → Display → Graphics, add the browser, and choose "High performance". On macOS, plug in the power adapter, or turn off automatic graphics switching.
5. **Remote desktop and virtual machines.** These sessions often have no GPU. Run the page on the machine that drives the display.

### The ocean renders but stutters

- Close other GPU-heavy tabs and programs.
- Set **Picture quality** to Balanced or Efficient, or force a lower render resolution with `?w=1920&h=1080` or `?w=1280&h=720`.
- Turn on **Onscreen information** in Settings → General to see the frame rate and GPU time.

### Weather or places do not load

Weather, alerts, and place lookups need network access to `api.open-meteo.com`, `geocoding-api.open-meteo.com`, `api.zippopotam.us`, and `api.weather.gov`. A firewall or a content blocker can stop them. The ocean and sky still render. National Weather Service alerts only exist for U.S. locations.

### There is no sound

Browsers block audio until the page receives a click or key press. Press **M** or the Sound button. Background music needs `media/track001.mp3` next to the HTML file; when you open a downloaded `ocean.html`, create a `media` folder beside it for the track.

### Settings look wrong after an update

Open Settings and choose **Reset to defaults**. Settings are stored per browser and per origin, so `file://` and the GitHub Pages site keep separate settings.

## Reporting a GPU problem

Open a [bug report](https://github.com/jfayling/fayling-web-ocean-pictureframe/issues/new?template=bug_report.yml) with your browser version, operating system, GPU model and driver version, and the contents of the error overlay or the browser console. The WebGPU section of `chrome://gpu` is especially helpful.
