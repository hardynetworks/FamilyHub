/**
 * Local weather from Open-Meteo (https://open-meteo.com): free, no API key.
 * The server fetches and caches the forecast so every screen shares one request every few minutes.
 */
import { getSetting, onSettingsChange } from './settings';
import { HttpError } from './util';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const CACHE_MS = 15 * 60_000;

export function weatherConfig() {
  const lat = Number(getSetting('weatherLatitude'));
  const lon = Number(getSetting('weatherLongitude'));
  const hasLocation = getSetting('weatherLatitude') !== '' && Number.isFinite(lat) && Number.isFinite(lon);
  return {
    enabled: getSetting('weatherEnabled') && hasLocation,
    name: getSetting('weatherLocationName'),
    lat,
    lon,
    units: getSetting('weatherUnits') === 'celsius' ? ('celsius' as const) : ('fahrenheit' as const),
  };
}

export interface WeatherDto {
  enabled: boolean;
  location?: string;
  units?: 'fahrenheit' | 'celsius';
  current?: { temp: number; feelsLike: number; code: number; isDay: boolean; wind: number; humidity: number; time: string };
  daily?: { date: string; code: number; max: number; min: number; precipChance: number | null; sunrise: string; sunset: string }[];
  updatedAt?: string;
}

let cache: { key: string; at: number; data: WeatherDto } | null = null;
onSettingsChange(() => (cache = null));

export async function getWeather(): Promise<WeatherDto> {
  const cfg = weatherConfig();
  if (!cfg.enabled) return { enabled: false };
  const key = `${cfg.lat},${cfg.lon},${cfg.units}`;
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.data;

  const q = new URLSearchParams({
    latitude: String(cfg.lat),
    longitude: String(cfg.lon),
    current: 'temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m,relative_humidity_2m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset',
    temperature_unit: cfg.units,
    wind_speed_unit: cfg.units === 'fahrenheit' ? 'mph' : 'kmh',
    timezone: 'auto',
    forecast_days: '6',
  });
  let j: any;
  try {
    const r = await fetch(`${FORECAST_URL}?${q}`, { signal: AbortSignal.timeout(10_000) });
    j = await r.json();
    if (!r.ok) throw new Error(j?.reason ?? `HTTP ${r.status}`);
  } catch (e: any) {
    // Keep showing the last good forecast if Open-Meteo is briefly unreachable.
    if (cache && cache.key === key) return cache.data;
    throw new HttpError(502, `Weather unavailable: ${e.message}`);
  }
  const c = j.current ?? {};
  const d = j.daily ?? {};
  const data: WeatherDto = {
    enabled: true,
    location: cfg.name,
    units: cfg.units,
    current: {
      temp: c.temperature_2m,
      feelsLike: c.apparent_temperature,
      code: c.weather_code,
      isDay: c.is_day === 1,
      wind: c.wind_speed_10m,
      humidity: c.relative_humidity_2m,
      time: c.time,
    },
    daily: (d.time ?? []).map((date: string, i: number) => ({
      date,
      code: d.weather_code?.[i],
      max: d.temperature_2m_max?.[i],
      min: d.temperature_2m_min?.[i],
      precipChance: d.precipitation_probability_max?.[i] ?? null,
      sunrise: d.sunrise?.[i],
      sunset: d.sunset?.[i],
    })),
    updatedAt: new Date().toISOString(),
  };
  cache = { key, at: Date.now(), data };
  return data;
}

/** City / postal-code search for the location picker. */
export async function searchLocations(query: string) {
  const q = new URLSearchParams({ name: query, count: '8', language: 'en', format: 'json' });
  const r = await fetch(`${GEOCODE_URL}?${q}`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new HttpError(502, `Location search failed (HTTP ${r.status})`);
  const j: any = await r.json();
  return (j.results ?? []).map((x: any) => ({
    name: x.name as string,
    region: [x.admin1, x.country].filter(Boolean).join(', '),
    label: [x.name, x.admin1, x.country_code].filter(Boolean).join(', '),
    latitude: x.latitude as number,
    longitude: x.longitude as number,
    timezone: x.timezone as string | undefined,
  }));
}
