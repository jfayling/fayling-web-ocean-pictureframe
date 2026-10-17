const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J2000 = Date.UTC(2000, 0, 1, 12);

function norm(angle) {
  angle %= Math.PI * 2;
  return angle < 0 ? angle + Math.PI * 2 : angle;
}

function equatorial(lon, lat = 0) {
  const e = 23.4397 * RAD;
  return {
    ra: Math.atan2(Math.sin(lon) * Math.cos(e) - Math.tan(lat) * Math.sin(e), Math.cos(lon)),
    dec: Math.asin(Math.sin(lat) * Math.cos(e) + Math.cos(lat) * Math.sin(e) * Math.sin(lon)),
  };
}

function sunCoords(days) {
  const mean = (357.5291 + 0.98560028 * days) * RAD;
  const center = (1.9148 * Math.sin(mean) + 0.02 * Math.sin(2 * mean) + 0.0003 * Math.sin(3 * mean)) * RAD;
  return equatorial(mean + center + 102.9372 * RAD + Math.PI);
}

// Main periodic terms of the lunar theory: about 0.3 degree accuracy, enough for the
// phase shape and the moon's place in the sky.
function moonCoords(days) {
  const L = (218.316 + 13.176396 * days) * RAD;
  const Mm = (134.963 + 13.064993 * days) * RAD;
  const Ms = (357.529 + 0.98560028 * days) * RAD;
  const D = (297.850 + 12.190749 * days) * RAD;
  const F = (93.272 + 13.229350 * days) * RAD;
  const lon = L + RAD * (
    6.289 * Math.sin(Mm) +
    1.274 * Math.sin(2 * D - Mm) +
    0.658 * Math.sin(2 * D) +
    0.214 * Math.sin(2 * Mm) -
    0.186 * Math.sin(Ms) -
    0.114 * Math.sin(2 * F)
  );
  const lat = RAD * (
    5.128 * Math.sin(F) +
    0.281 * Math.sin(Mm + F) +
    0.278 * Math.sin(Mm - F) +
    0.173 * Math.sin(2 * D - F)
  );
  return equatorial(lon, lat);
}

function horizontal(coords, days, latitude, longitude) {
  const lat = latitude * RAD;
  const sidereal = (280.16 + 360.9856235 * days + longitude) * RAD;
  const hour = norm(sidereal - coords.ra);
  const altitude = Math.asin(
    Math.sin(lat) * Math.sin(coords.dec) +
    Math.cos(lat) * Math.cos(coords.dec) * Math.cos(hour)
  );
  // Clockwise from geographic north: north=0, east=90.
  const azimuth = norm(Math.atan2(
    Math.sin(hour),
    Math.cos(hour) * Math.sin(lat) - Math.tan(coords.dec) * Math.cos(lat)
  ) + Math.PI);
  return { altitude, azimuth };
}

function direction({ altitude, azimuth }, latitude) {
  const horizontalScale = Math.cos(altitude);
  // Geographic north is -Z. In the northern hemisphere the daily arc is in the south,
  // so turn that arc toward the default view; south of the equator, face north instead.
  const facingEquator = latitude >= 0 ? -1 : 1;
  return [
    facingEquator * Math.sin(azimuth) * horizontalScale,
    Math.sin(altitude),
    facingEquator * -Math.cos(azimuth) * horizontalScale,
  ];
}

export function celestialState(date, latitude, longitude) {
  const days = (date.getTime() - J2000) / DAY_MS;
  const sun = horizontal(sunCoords(days), days, latitude, longitude);
  const moon = horizontal(moonCoords(days), days, latitude, longitude);
  // Seen from the surface the moon sits about one degree lower than from Earth's centre.
  moon.altitude -= 0.95 * RAD * Math.cos(moon.altitude);
  const sunDirection = direction(sun, latitude);
  const moonDirection = direction(moon, latitude);
  const cosPhase = -(sunDirection[0] * moonDirection[0] + sunDirection[1] * moonDirection[1] + sunDirection[2] * moonDirection[2]);
  return {
    sunDirection,
    moonDirection,
    // The celestial north pole orients the moon's face (its north points toward it).
    poleDirection: direction({ altitude: latitude * RAD, azimuth: 0 }, latitude),
    sunAltitude: sun.altitude / RAD,
    sunAzimuth: sun.azimuth / RAD,
    moonAltitude: moon.altitude / RAD,
    moonAzimuth: moon.azimuth / RAD,
    moonIllumination: (1 + cosPhase) / 2,
  };
}
