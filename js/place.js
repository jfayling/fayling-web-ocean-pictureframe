const CACHE_KEY = 'web-ocean-place-cache';
const LEGACY_KEYS = ['web-ocean-weather-location', 'web-ocean-zip-location'];
const PLACE_TEXT = /^-?[\p{L}\p{N}][\p{L}\p{N}\s.,'’-]*$/u;
const memory = new Map();

function fold(value) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[.'’]/g, '');
}

function digits(length) {
  return (value) => {
    const numeric = value.replace(/\D/g, '');
    return numeric.length === length ? numeric : '';
  };
}

function canadian(value) {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z]\d[A-Z]/.test(compact) ? compact.slice(0, 3) : '';
}

// Zippopotam wants the outward code only: SW1A 1AA -> SW1A, M1 1AE -> M1.
function british(value) {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(compact)) return compact.slice(0, -3);
  if (/^[A-Z]{1,2}\d[A-Z\d]?$/.test(compact)) return compact;
  return '';
}

function japanese(value) {
  const numeric = value.replace(/\D/g, '');
  return numeric.length === 7 ? `${numeric.slice(0, 3)}-${numeric.slice(3)}` : '';
}

function brazilian(value) {
  const numeric = value.replace(/\D/g, '');
  return numeric.length === 8 ? `${numeric.slice(0, 5)}-${numeric.slice(5)}` : '';
}

function polish(value) {
  const numeric = value.replace(/\D/g, '');
  return numeric.length === 5 ? `${numeric.slice(0, 2)}-${numeric.slice(2)}` : '';
}

function dutch(value) {
  const match = value.match(/\d{4}/);
  return match ? match[0] : '';
}

function portuguese(value) {
  const numeric = value.replace(/\D/g, '');
  if (numeric.length === 7) return `${numeric.slice(0, 4)}-${numeric.slice(4)}`;
  if (numeric.length === 4) return numeric;
  return '';
}

const POSTAL = {};
function addPostal(names, code, normalize) {
  for (const name of names) POSTAL[fold(name)] = { code, normalize };
}
addPostal(['australia'], 'au', digits(4));
addPostal(['austria', 'österreich', 'osterreich'], 'at', digits(4));
addPostal(['belgium', 'belgique', 'belgië', 'belgie'], 'be', digits(4));
addPostal(['brazil', 'brasil'], 'br', brazilian);
addPostal(['canada'], 'ca', canadian);
addPostal(['denmark', 'danmark'], 'dk', digits(4));
addPostal(['finland', 'suomi'], 'fi', digits(5));
addPostal(['france'], 'fr', digits(5));
addPostal(['germany', 'deutschland'], 'de', digits(5));
addPostal(['india'], 'in', digits(6));
addPostal(['italy', 'italia'], 'it', digits(5));
addPostal(['japan'], 'jp', japanese);
addPostal(['mexico', 'méxico', 'mexico'], 'mx', digits(5));
addPostal(['netherlands', 'the netherlands', 'holland'], 'nl', dutch);
addPostal(['new zealand'], 'nz', digits(4));
addPostal(['norway', 'norge'], 'no', digits(4));
addPostal(['poland', 'polska'], 'pl', polish);
addPostal(['portugal'], 'pt', portuguese);
addPostal(['south africa'], 'za', digits(4));
addPostal(['spain', 'españa', 'espana'], 'es', digits(5));
addPostal(['sweden', 'sverige'], 'se', digits(5));
addPostal(['switzerland', 'schweiz', 'suisse', 'svizzera'], 'ch', digits(4));
addPostal(['united kingdom', 'uk', 'great britain', 'britain', 'england', 'scotland', 'wales', 'northern ireland'], 'gb', british);
addPostal(['united states', 'united states of america', 'usa', 'us', 'america'], 'us', digits(5));

// Qualifiers that name a region rather than a country. Checked before country codes
// so CA is California and DE can still match Delaware as well as Germany.
const REGION_ABBR = {
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california',
  co: 'colorado', ct: 'connecticut', de: 'delaware', dc: 'district of columbia',
  fl: 'florida', ga: 'georgia', hi: 'hawaii', id: 'idaho', il: 'illinois',
  in: 'indiana', ia: 'iowa', ks: 'kansas', ky: 'kentucky', la: 'louisiana',
  me: 'maine', md: 'maryland', ma: 'massachusetts', mi: 'michigan', mn: 'minnesota',
  ms: 'mississippi', mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada',
  nh: 'new hampshire', nj: 'new jersey', nm: 'new mexico', ny: 'new york',
  nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma', or: 'oregon',
  pa: 'pennsylvania', ri: 'rhode island', sc: 'south carolina', sd: 'south dakota',
  tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont', va: 'virginia',
  wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming',
  on: 'ontario', qc: 'quebec', bc: 'british columbia', ab: 'alberta',
  ns: 'nova scotia', nb: 'new brunswick', mb: 'manitoba', sk: 'saskatchewan',
  pe: 'prince edward island', nl: 'newfoundland and labrador',
};

const COUNTRY_ABBR = {
  uk: 'gb', gb: 'gb', britain: 'gb', 'great britain': 'gb',
  us: 'us', usa: 'us', america: 'us', 'united states': 'us', 'united states of america': 'us',
  uae: 'ae', holland: 'nl', 'the netherlands': 'nl', czechia: 'cz', 'czech republic': 'cz',
  korea: 'kr', 'south korea': 'kr', russia: 'ru', brasil: 'br',
  fr: 'fr', de: 'de', jp: 'jp', au: 'au', nz: 'nz', br: 'br', mx: 'mx', za: 'za',
  nl: 'nl', se: 'se', no: 'no', it: 'it', es: 'es', ch: 'ch', pt: 'pt', ie: 'ie',
  pl: 'pl', in: 'in', at: 'at', be: 'be', dk: 'dk', fi: 'fi',
};

function storage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function loadJSON(key) {
  const store = storage();
  if (!store) return null;
  try { return JSON.parse(store.getItem(key) || 'null'); } catch { return null; }
}

function barePostal(value) {
  const trimmed = String(value ?? '').trim();
  if (/^\d{5}(?:-\d{4})?$/.test(trimmed)) return false;
  return /^\d[\d\s-]{2,}$/.test(trimmed);
}

export function placeHint(value) {
  if (barePostal(value)) return 'Add the country after that postal code, such as 2000, Australia.';
  return 'Enter a city and country, or a 5-digit US ZIP code';
}

export function acceptedPlace(value) {
  if (typeof value !== 'string') return '';
  const query = value.trim().replace(/\s+/g, ' ');
  if (query.length < 2 || query.length > 80 || !PLACE_TEXT.test(query)) return '';
  const zip = query.match(/^(\d{5})(?:-\d{4})?$/);
  if (zip) return zip[1];
  if (barePostal(query)) return '';
  return query;
}

function asLocation(entry, query) {
  const latitude = Number(entry?.latitude);
  const longitude = Number(entry?.longitude);
  const stored = entry?.query || entry?.zip || '';
  if (!stored || fold(stored) !== fold(query)) return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    query,
    latitude,
    longitude,
    name: entry.name || query,
    country: entry.country || (/^\d{5}$/.test(query) ? 'US' : ''),
  };
}

function cachedPlace(query) {
  const key = fold(query);
  if (memory.has(key)) return memory.get(key);
  const entries = loadJSON(CACHE_KEY);
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const location = asLocation(entry, query);
      if (location) return location;
    }
  }
  for (const legacy of LEGACY_KEYS) {
    const location = asLocation(loadJSON(legacy), query);
    if (location) return location;
  }
  return null;
}

function remember(location) {
  memory.set(fold(location.query), location);
  const store = storage();
  if (!store) return;
  const current = loadJSON(CACHE_KEY);
  const entries = (Array.isArray(current) ? current : [])
    .filter((entry) => fold(entry?.query || '') !== fold(location.query));
  entries.unshift(location);
  try { store.setItem(CACHE_KEY, JSON.stringify(entries.slice(0, 12))); } catch { /* unavailable */ }
}

async function fetchJSON(url) {
  let response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error('Could not reach the location service');
  }
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    throw new Error('Could not reach the location service');
  }
}

function chooseZipPlace(places) {
  if (!places?.length) return null;
  const names = places.map((place) => place['place name'] || '');
  const broader = places.filter((place) => {
    const name = place['place name'] || '';
    return names.some((other) => other.length > name.length && other.startsWith(name));
  });
  if (!broader.length) return places[0];
  broader.sort((a, b) => a['place name'].length - b['place name'].length);
  return broader[0];
}

function fromZip(query, json) {
  const place = chooseZipPlace(json?.places);
  const latitude = Number(place?.latitude);
  const longitude = Number(place?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const country = String(json['country abbreviation'] || '').toUpperCase();
  const city = place['place name'] || query;
  const region = place['state abbreviation'] || place.state || '';
  const name = country === 'US'
    ? [city, region].filter(Boolean).join(', ')
    : [city, json.country].filter(Boolean).join(', ');
  return { query, latitude, longitude, name, country };
}

async function usZip(query) {
  const json = await fetchJSON(`https://api.zippopotam.us/us/${query}`);
  const location = fromZip(query, json);
  if (!location) {
    throw new Error('That ZIP code was not found. Outside the United States, enter a city and country, such as Lisbon, Portugal.');
  }
  return location;
}

function parseCoordinates(query) {
  const match = query.match(/^(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!match || !query.includes('.')) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw new Error('Latitude must be between -90 and 90, and longitude between -180 and 180.');
  }
  const ns = latitude >= 0 ? 'N' : 'S';
  const ew = longitude >= 0 ? 'E' : 'W';
  return {
    latitude,
    longitude,
    name: `${Math.abs(latitude).toFixed(2)}° ${ns}, ${Math.abs(longitude).toFixed(2)}° ${ew}`,
  };
}

async function postalLookup(query) {
  const comma = query.lastIndexOf(',');
  if (comma === -1) return null;
  const code = query.slice(0, comma).trim();
  const countryName = fold(query.slice(comma + 1).trim());
  if (!/\d/.test(code) || !POSTAL[countryName]) return null;
  const { code: country, normalize } = POSTAL[countryName];
  const postal = normalize(code);
  if (!postal) return null;
  const json = await fetchJSON(`https://api.zippopotam.us/${country}/${encodeURIComponent(postal)}`);
  return fromZip(query, json);
}

function nameScore(resultName, city) {
  if (!city || !resultName) return 0;
  if (resultName === city) return 100;
  if (city.length >= 4 && (resultName.startsWith(city) || city.startsWith(resultName))) return 80;
  return 0;
}

function qualifierScore(result, part) {
  const admin1 = fold(result.admin1 || '');
  const admin2 = fold(result.admin2 || '');
  const country = fold(result.country || '');
  const code = (result.country_code || '').toLowerCase();
  const region = REGION_ABBR[part];
  const countryCode = COUNTRY_ABBR[part];
  const regionHit = (region && admin1 === region) || admin1 === part || admin2 === part;
  const countryHit = country === part || (countryCode && code === countryCode);
  if (regionHit || countryHit) return 50;
  if ((admin1 && (admin1.includes(part) || part.includes(admin1))) || (country && country.includes(part))) return 25;
  return -30;
}

function describeGeocode(result) {
  const name = result.name || '';
  const region = result.admin1 && result.admin1 !== name ? result.admin1 : '';
  const country = result.country && result.country !== name && result.country !== region ? result.country : '';
  if ((result.country_code || '').toUpperCase() === 'US') return [name, region].filter(Boolean).join(', ');
  if (country) return [name, country].join(', ');
  return [name, region].filter(Boolean).join(', ');
}

function notFoundMessage(query) {
  if (!/[\p{Script=Latin}\d]/u.test(query)) {
    return 'Could not find that place. Enter the city name in English, such as Tokyo or Cairo.';
  }
  return 'Could not find that place. Try the city and country, such as Lisbon, Portugal.';
}

async function searchPlaces(name, countryCode) {
  const params = new URLSearchParams({ name, count: '100', language: 'en', format: 'json' });
  if (countryCode) params.set('countryCode', countryCode);
  const json = await fetchJSON(`https://geocoding-api.open-meteo.com/v1/search?${params}`);
  return json?.results || [];
}

function populatedPlace(result) {
  const code = String(result.feature_code || '');
  return !code || code.startsWith('PPL');
}

function nameMatches(result, city) {
  const name = fold(result.name || '');
  const query = fold(city);
  return Boolean(name && query && (name === query || name.startsWith(query)));
}

function rankPlaces(results, query) {
  const parts = query.split(',').map((part) => fold(part.trim())).filter(Boolean);
  const [city, ...rest] = parts;
  let best = null;
  let bestScore = 0;
  for (const result of results) {
    if (!Number.isFinite(result.latitude) || !Number.isFinite(result.longitude)) continue;
    const matched = nameScore(fold(result.name || ''), city);
    if (!matched) continue;
    let score = matched + Math.log10((result.population || 0) + 1);
    if (rest.length) {
      const extra = rest.reduce((sum, part) => sum + qualifierScore(result, part), 0);
      if (extra < 20) continue;
      score += extra;
    }
    if (score > bestScore) {
      bestScore = score;
      best = result;
    }
  }
  return best;
}

async function geocode(query) {
  const parts = query.split(',').map((part) => part.trim()).filter(Boolean);
  let best = rankPlaces(await searchPlaces(query), query);
  if (!best && parts.length > 1) {
    const countryCode = parts.slice(1).map((part) => COUNTRY_ABBR[fold(part)]).find(Boolean);
    // "DE" is both Germany and Delaware. A region match such as Dover, DE is kept above.
    // This second search covers Berlin, DE, where the first pass only saw Delaware.
    if (countryCode) best = rankPlaces(await searchPlaces(parts[0], countryCode), query);
  }
  if (!best) throw new Error(notFoundMessage(query));
  return {
    query,
    latitude: best.latitude,
    longitude: best.longitude,
    name: describeGeocode(best) || query,
    country: String(best.country_code || '').toUpperCase(),
  };
}

function choiceLabel(result) {
  const parts = [result.name, result.admin1, result.country];
  return parts.filter((part, index) => part && parts.indexOf(part) === index).join(', ');
}

function choiceFromResult(result) {
  const name = describeGeocode(result) || result.name || '';
  return {
    value: name,
    name,
    label: choiceLabel(result) || name,
    latitude: result.latitude,
    longitude: result.longitude,
    country: String(result.country_code || '').toUpperCase(),
  };
}

export function rememberChoice(choice) {
  const query = acceptedPlace(choice?.value);
  const latitude = Number(choice?.latitude);
  const longitude = Number(choice?.longitude);
  if (!query || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
  remember({
    query,
    latitude,
    longitude,
    name: choice.name || query,
    country: choice.country || '',
  });
}

export async function suggestPlaces(value) {
  const query = String(value || '').trim().replace(/\s+/g, ' ');
  if (query.length < 2) return [];
  const choices = [];
  const seen = new Set();
  const add = (choice) => {
    if (!choice?.value || !Number.isFinite(choice.latitude) || !Number.isFinite(choice.longitude)) return;
    const id = `${choice.latitude.toFixed(2)},${choice.longitude.toFixed(2)}`;
    if (seen.has(id)) return;
    seen.add(id);
    choices.push(choice);
  };
  if (/^\d{5}$/.test(query)) {
    try {
      const place = await usZip(query);
      add({ value: place.name, name: place.name, label: `${place.name}, United States`, latitude: place.latitude, longitude: place.longitude, country: place.country });
    } catch (error) {
      if (error.message === 'Could not reach the location service') throw error;
    }
  }
  try {
    const coordinates = parseCoordinates(query);
    if (coordinates) add({ value: query, name: coordinates.name, label: coordinates.name, country: '', ...coordinates });
  } catch (error) {
    if (/Latitude must be/.test(error.message)) throw error;
  }
  const postal = await postalLookup(query);
  if (postal) add({ value: postal.name, name: postal.name, label: postal.name, latitude: postal.latitude, longitude: postal.longitude, country: postal.country });
  const parts = query.split(',').map((part) => part.trim()).filter(Boolean);
  const countryCode = parts.slice(1).map((part) => COUNTRY_ABBR[fold(part)]).find(Boolean);
  const batches = [await searchPlaces(query)];
  if (countryCode) batches.push(await searchPlaces(parts[0], countryCode));
  const matches = batches.flat().filter((result) => nameMatches(result, parts[0] || query));
  const places = matches.filter(populatedPlace);
  for (const result of (places.length ? places : matches)) add(choiceFromResult(result));
  choices.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));
  return choices;
}

async function lookup(query) {
  if (/^\d{5}$/.test(query)) return usZip(query);
  const coordinates = parseCoordinates(query);
  if (coordinates) return { query, country: '', ...coordinates };
  const postal = await postalLookup(query);
  if (postal) return postal;
  return geocode(query);
}

export async function resolvePlace(value) {
  const query = acceptedPlace(value);
  if (!query) throw new Error(placeHint(value));
  const cached = cachedPlace(query);
  if (cached) {
    memory.set(fold(query), cached);
    return cached;
  }
  const location = await lookup(query);
  remember(location);
  return location;
}
