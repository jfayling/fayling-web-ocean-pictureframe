import { resolvePlace } from './place.js';

const ICONS = {
  drop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2.5S5.8 10 5.8 15a6.2 6.2 0 0 0 12.4 0C18.2 10 12 2.5 12 2.5Z"/><path d="M9 16.2a3.2 3.2 0 0 0 3 2.1"/></svg>',
  temp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 14.8V5a3 3 0 0 1 6 0v9.8a5 5 0 1 1-6 0Z"/><path d="M12 8v9"/></svg>',
  humidity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2.5S5.8 10 5.8 15a6.2 6.2 0 0 0 12.4 0C18.2 10 12 2.5 12 2.5Z"/><path d="M9 16.2a3.2 3.2 0 0 0 3 2.1"/></svg>',
  wind: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 8h11.5a2.5 2.5 0 1 0-2.3-3.5M3 12h16a2.5 2.5 0 1 1-2.3 3.5M3 16h7"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 9v5m0 3v.1"/></svg>',
};

function condition(code) {
  if (code === 0) return ['Clear', 'clear'];
  if (code <= 2) return ['Partly cloudy', 'partly'];
  if (code === 3) return ['Overcast', 'cloud'];
  if (code === 45 || code === 48) return ['Fog', 'fog'];
  if (code >= 51 && code <= 57) return ['Drizzle', 'rain'];
  if (code >= 61 && code <= 67) return ['Rain', 'rain'];
  if (code >= 71 && code <= 77) return ['Snow', 'snow'];
  if (code >= 80 && code <= 82) return ['Rain showers', 'rain'];
  if (code >= 85 && code <= 86) return ['Snow showers', 'snow'];
  if (code >= 95) return ['Thunderstorms', 'storm'];
  return ['Current conditions', 'cloud'];
}

function weatherIcon(kind, day) {
  const sun = '<circle cx="31" cy="28" r="11" fill="currentColor"/><g stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M31 8v-5m0 50v-5M11 28H6m50 0h-5M17 14l-4-4m36 36-4-4m0-28 4-4M13 46l4-4"/></g>';
  const moon = '<path d="M40 8a21 21 0 1 0 9 37A18 18 0 0 1 40 8Z" fill="currentColor"/>';
  const cloud = '<path d="M17 49h30a10 10 0 0 0 1-20 16 16 0 0 0-30-2A11 11 0 0 0 17 49Z" fill="#e9f3fa" stroke="#adc1cf" stroke-width="2"/>';
  const base = day ? sun : moon;
  const wrap = (body) => `<svg viewBox="0 0 64 64" aria-hidden="true">${body}</svg>`;
  if (kind === 'clear') return wrap(base);
  if (kind === 'partly') return wrap(base + cloud);
  if (kind === 'cloud') return wrap('<path d="M14 47h36a12 12 0 0 0 0-24 19 19 0 0 0-35-1A13 13 0 0 0 14 47Z" fill="#e9f3fa" stroke="#adc1cf" stroke-width="2"/>');
  if (kind === 'fog') return wrap(cloud + '<g stroke="#d9e8ef" stroke-width="3" stroke-linecap="round"><path d="M10 53h42M16 59h34"/></g>');
  if (kind === 'snow') return wrap(cloud + '<g fill="#d8f3ff"><circle cx="23" cy="56" r="2"/><circle cx="35" cy="58" r="2"/><circle cx="47" cy="55" r="2"/></g>');
  if (kind === 'storm') return wrap(cloud + '<path d="m35 45-8 12h7l-3 7 13-15h-8l4-4Z" fill="#ffd24f"/>');
  return wrap(cloud + '<g stroke="#7dd7ff" stroke-width="3" stroke-linecap="round"><path d="m22 53-3 6m16-6-3 6m16-6-3 6"/></g>');
}

function detail(icon, text) {
  return `<span class="weather-detail">${ICONS[icon]}<span>${text}</span></span>`;
}

function compass(degrees) {
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return points[Math.round((Number(degrees) || 0) / 45) % 8];
}

function rounded(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function tempBlock(config, current, unit, high, low) {
  const currentHTML = config.weatherTemp
    ? `<div class="weather-temp">${Math.round(current.temperature_2m)}${unit}</div>`
    : '';
  const rangeHTML = high == null || low == null ? '' : `<div class="weather-range" aria-label="Today high ${high} degrees, low ${low} degrees"><span>H ${high}°</span><span>L ${low}°</span></div>`;
  return currentHTML || rangeHTML ? `<div class="weather-temp-block">${currentHTML}${rangeHTML}</div>` : '';
}

function todayTemperatures(daily, currentTime) {
  const times = daily?.time || [];
  if (!times.length) return null;
  const today = String(currentTime || '').slice(0, 10);
  const found = times.indexOf(today);
  const index = found >= 0 ? found : 0;
  return {
    high: daily.temperature_2m_max?.[index],
    low: daily.temperature_2m_min?.[index],
  };
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function highestAlert(features) {
  const rank = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };
  return [...features].sort((a, b) => (rank[b.properties?.severity] || 0) - (rank[a.properties?.severity] || 0))[0];
}

function alertStatement(props) {
  const clean = (value) => String(value || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const body = [clean(props.description), clean(props.instruction)].filter(Boolean).join('\n\n');
  return body || props.headline || props.areaDesc || 'See local authorities for details';
}

function playAlertScroll(root) {
  const viewport = root.querySelector('.weather-alert-scroll');
  const track = viewport?.querySelector('.weather-alert-track');
  const text = track?.querySelector('p');
  if (!text?.isConnected || track.querySelector('[aria-hidden]')) return;
  if (text.scrollHeight - viewport.clientHeight < 8) return;
  const clone = text.cloneNode(true);
  clone.setAttribute('aria-hidden', 'true');
  text.after(clone);
  // One line per second. The second copy makes the restart line up with the first.
  track.style.animationDuration = `${Math.min(180, Math.max(12, text.offsetHeight / 14))}s`;
  viewport.classList.add('scrolling');
}

export function createWeatherWidget(root, status) {
  let timer = 0;
  let request = 0;
  let controller = null;
  let lastConfig = null;
  let fetchDelay = 0;
  let data = null;

  function render(config) {
    root.hidden = !config.weather;
    root.dataset.position = config.weatherPosition;
    if (!config.weather || !data) return;
    if (data.error) {
      root.innerHTML = `<div class="weather-card weather-error">${escapeHTML(data.error)}</div>`;
      return;
    }
    const { current, hourly, daily, location, alerts } = data;
    const [label, icon] = condition(current.weather_code);
    const unit = config.weatherUnit === 'celsius' ? '°C' : '°F';
    const speedUnit = config.weatherUnit === 'celsius' ? 'km/h' : 'mph';
    const high = rounded(daily?.high);
    const low = rounded(daily?.low);
    const details = [];
    if (config.weatherFeels) details.push(detail('temp', `Feels ${Math.round(current.apparent_temperature)}${unit}`));
    if (config.weatherPrecip) {
      const chance = hourly.chances[0] ?? 0;
      details.push(detail('drop', `${chance}% · ${current.precipitation.toFixed(config.weatherUnit === 'celsius' ? 1 : 2)} ${config.weatherUnit === 'celsius' ? 'mm' : 'in'}`));
    }
    if (config.weatherHumidity) details.push(detail('humidity', `${current.relative_humidity_2m}%`));
    if (config.weatherWind) details.push(detail('wind', `${compass(current.wind_direction_10m)} ${Math.round(current.wind_speed_10m)} ${speedUnit}`));

    let alertHTML = '';
    if (config.weatherAlerts && alerts.length) {
      const alert = highestAlert(alerts);
      const props = alert.properties || {};
      const extra = alerts.length > 1 ? ` · ${alerts.length} active alerts` : '';
      const severity = ['Extreme', 'Severe', 'Moderate', 'Minor'].includes(props.severity) ? props.severity : 'Unknown';
      alertHTML = `<div class="weather-alert" data-severity="${severity}">
        <span class="weather-alert-icon">${ICONS.alert}</span><div><strong>${escapeHTML(props.event || 'Weather alert')}${extra}</strong>
        <div class="weather-alert-scroll"><div class="weather-alert-track"><p>${escapeHTML(alertStatement(props))}</p></div></div></div></div>`;
    }
    let forecastHTML = '';
    if (config.weatherForecast && hourly.times.length) {
      const hours = hourly.times.map((time, i) => {
        const text = new Intl.DateTimeFormat([], { hour: 'numeric' }).format(new Date(time));
        const temperature = rounded(hourly.temperatures?.[i]);
        const tempLine = temperature == null ? '' : `<strong>${temperature}°</strong>`;
        return `<div class="weather-hour"><time>${text}</time>${tempLine}<span class="weather-hour-rain">${hourly.chances[i] ?? 0}% rain</span></div>`;
      }).join('');
      forecastHTML = `<div class="weather-forecast">${hours}</div>`;
    }
    const updated = new Date(data.updatedAt);
    const updatedText = new Intl.DateTimeFormat([], {
      hour: 'numeric',
      minute: '2-digit',
      hour12: !config.clock24h,
    }).format(updated);
    root.innerHTML = `${alertHTML}<div class="weather-card"><div class="weather-main">
      <div class="weather-icon">${weatherIcon(icon, current.is_day)}</div>
      <div><button type="button" class="weather-place" title="${escapeHTML(location.name || location.query)}" aria-label="Change weather location, ${escapeHTML(location.name || location.query)}">${escapeHTML(location.name || location.query)}</button><div class="weather-condition">${label}</div></div>
      ${tempBlock(config, current, unit, high, low)}
      </div>${details.length ? `<div class="weather-details">${details.join('')}</div>` : ''}${forecastHTML}
      <time class="weather-updated" datetime="${updated.toISOString()}">Updated ${updatedText}</time></div>`;
    if (root.querySelector('.weather-alert-scroll')) requestAnimationFrame(() => playAlertScroll(root));
  }

  async function refresh(config) {
    if (!config.weather) return;
    const token = ++request;
    controller?.abort();
    controller = new AbortController();
    try {
      status('Updating weather…');
      const location = await resolvePlace(config.weatherZip);
      const metric = config.weatherUnit === 'celsius';
      const params = new URLSearchParams({
        latitude: location.latitude,
        longitude: location.longitude,
        current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,is_day',
        hourly: 'precipitation_probability,temperature_2m',
        daily: 'temperature_2m_max,temperature_2m_min',
        temperature_unit: metric ? 'celsius' : 'fahrenheit',
        wind_speed_unit: metric ? 'kmh' : 'mph',
        precipitation_unit: metric ? 'mm' : 'inch',
        timezone: 'auto',
        forecast_days: '2',
      });
      const weatherURL = `https://api.open-meteo.com/v1/forecast?${params}`;
      const alertURL = `https://api.weather.gov/alerts/active?point=${location.latitude},${location.longitude}`;
      const alerts = location.country === 'US'
        ? fetch(alertURL, { signal: controller.signal, headers: { Accept: 'application/geo+json' } }).then((r) => r.ok ? r.json() : { features: [] })
        : Promise.resolve({ features: [] });
      const [weatherResult, alertResult] = await Promise.allSettled([
        fetch(weatherURL, { signal: controller.signal }).then((r) => {
          if (!r.ok) throw new Error('Weather service unavailable');
          return r.json();
        }),
        alerts,
      ]);
      if (token !== request) return;
      if (weatherResult.status !== 'fulfilled') throw weatherResult.reason;
      const weather = weatherResult.value;
      const now = Date.now();
      const future = (weather.hourly?.time || []).map((time, i) => ({
        time,
        chance: weather.hourly.precipitation_probability?.[i],
        temperature: weather.hourly.temperature_2m?.[i],
      })).filter((item) => new Date(item.time).getTime() >= now - 1800000).slice(0, 3);
      data = {
        current: weather.current,
        location,
        alerts: alertResult.status === 'fulfilled' ? alertResult.value.features || [] : [],
        hourly: {
          times: future.map((item) => item.time),
          chances: future.map((item) => item.chance),
          temperatures: future.map((item) => item.temperature),
        },
        daily: todayTemperatures(weather.daily, weather.current?.time),
        updatedAt: now,
      };
      status(`${location.name || location.query} weather updated`);
      render(config);
    } catch (error) {
      if (error.name === 'AbortError' || token !== request) return;
      data = { error: error.message || 'Weather unavailable' };
      status(data.error);
      render(config);
    }
  }

  function update(config, fetchNow = false) {
    lastConfig = { ...config };
    render(lastConfig);
    clearInterval(timer);
    clearTimeout(fetchDelay);
    if (config.weather) {
      timer = setInterval(() => refresh(lastConfig), Math.max(1, config.weatherRefresh) * 60000);
      if (fetchNow || !data) fetchDelay = setTimeout(() => refresh(lastConfig), 50);
    }
  }

  return { update, refresh: () => lastConfig && refresh(lastConfig) };
}
