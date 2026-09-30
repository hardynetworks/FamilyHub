import { useQuery } from '@tanstack/react-query';
import { WeatherData, api } from '../lib/api';
import { fmtWeekday, today } from '../lib/dates';
import { Icon } from './ui';

export function useWeather() {
  return useQuery({
    queryKey: ['weather'],
    queryFn: () => api<WeatherData>('/weather'),
    staleTime: 10 * 60_000,
    refetchInterval: 15 * 60_000,
    retry: 1,
  });
}

/** WMO weather code → label + emoji (https://open-meteo.com/en/docs, "WMO Weather interpretation codes"). */
export function describeWeather(code: number | undefined, isDay = true): { label: string; icon: string } {
  switch (code) {
    case 0:
      return { label: isDay ? 'Sunny' : 'Clear', icon: isDay ? '☀️' : '🌙' };
    case 1:
      return { label: isDay ? 'Mostly sunny' : 'Mostly clear', icon: isDay ? '🌤️' : '🌙' };
    case 2:
      return { label: 'Partly cloudy', icon: isDay ? '⛅' : '☁️' };
    case 3:
      return { label: 'Cloudy', icon: '☁️' };
    case 45:
    case 48:
      return { label: 'Foggy', icon: '🌫️' };
    case 51:
    case 53:
    case 55:
      return { label: 'Drizzle', icon: '🌦️' };
    case 56:
    case 57:
      return { label: 'Freezing drizzle', icon: '🌧️' };
    case 61:
      return { label: 'Light rain', icon: '🌦️' };
    case 63:
      return { label: 'Rain', icon: '🌧️' };
    case 65:
      return { label: 'Heavy rain', icon: '🌧️' };
    case 66:
    case 67:
      return { label: 'Freezing rain', icon: '🌧️' };
    case 71:
      return { label: 'Light snow', icon: '🌨️' };
    case 73:
      return { label: 'Snow', icon: '🌨️' };
    case 75:
      return { label: 'Heavy snow', icon: '❄️' };
    case 77:
      return { label: 'Snow grains', icon: '🌨️' };
    case 80:
    case 81:
      return { label: 'Showers', icon: '🌦️' };
    case 82:
      return { label: 'Heavy showers', icon: '🌧️' };
    case 85:
    case 86:
      return { label: 'Snow showers', icon: '🌨️' };
    case 95:
      return { label: 'Thunderstorms', icon: '⛈️' };
    case 96:
    case 99:
      return { label: 'Thunderstorms with hail', icon: '⛈️' };
    default:
      return { label: '—', icon: '🌡️' };
  }
}

const deg = (n: number | undefined) => (n === undefined || n === null ? '–' : `${Math.round(n)}°`);

/** Compact current conditions for the Home header. */
export function WeatherNow() {
  const { data } = useWeather();
  if (!data?.enabled || !data.current) return null;
  const c = data.current;
  const d = describeWeather(c.code, c.isDay);
  const todayF = data.daily?.[0];
  return (
    <div className="wx-now" title={`${d.label} in ${data.location}. Feels like ${deg(c.feelsLike)}, humidity ${c.humidity}%, wind ${Math.round(c.wind)} ${data.units === 'fahrenheit' ? 'mph' : 'km/h'}`}>
      <span className="wx-now-icon" aria-hidden="true">{d.icon}</span>
      <div>
        <div className="wx-now-temp">{deg(c.temp)}</div>
        <div className="wx-now-sub">
          {d.label}
          {todayF && (
            <>
              {' · '}H {deg(todayF.max)} L {deg(todayF.min)}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Moon phase from the date (no API needed). */
export function moonPhase(d = new Date()) {
  const synodic = 29.530588853;
  const knownNew = Date.UTC(2000, 0, 6, 18, 14);
  const age = ((((d.getTime() - knownNew) / 86400000) % synodic) + synodic) % synodic;
  const f = age / synodic;
  const phases = [
    ['New moon', '🌑'],
    ['Waxing crescent', '🌒'],
    ['First quarter', '🌓'],
    ['Waxing gibbous', '🌔'],
    ['Full moon', '🌕'],
    ['Waning gibbous', '🌖'],
    ['Last quarter', '🌗'],
    ['Waning crescent', '🌘'],
  ];
  const [name, icon] = phases[Math.round(f * 8) % 8];
  return { name, icon, illumination: Math.round(((1 - Math.cos(2 * Math.PI * f)) / 2) * 100) };
}

/** "2026-09-30T06:52" (location-local) -> minutes since midnight. */
const minutesOf = (iso?: string) => {
  const m = iso?.match(/T(\d{2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};
const clockLabel = (iso?: string) => {
  const mins = minutesOf(iso);
  if (!Number.isFinite(mins)) return '–';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const hourLabel = (iso: string, first: boolean) => {
  if (first) return 'Now';
  const h = Number(iso.slice(11, 13));
  return `${((h + 11) % 12) + 1}${h < 12 ? 'am' : 'pm'}`;
};

/** Colour for a temperature (blue → teal → yellow → orange → red), for the forecast bars. */
function tempColor(t: number, units: string | undefined) {
  const f = units === 'celsius' ? t * 1.8 + 32 : t;
  const stops: [number, string][] = [
    [20, '#60a5fa'],
    [45, '#22d3ee'],
    [62, '#a3e635'],
    [75, '#facc15'],
    [85, '#fb923c'],
    [98, '#ef4444'],
  ];
  for (let i = 0; i < stops.length; i++) if (f <= stops[i][0]) return stops[i][1];
  return stops[stops.length - 1][1];
}

/** Daylight arc: where the sun is between sunrise and sunset. */
function SunArc({ sunrise, sunset, now }: { sunrise?: string; sunset?: string; now?: string }) {
  const rise = minutesOf(sunrise);
  const set = minutesOf(sunset);
  const cur = minutesOf(now);
  if (![rise, set, cur].every(Number.isFinite)) return null;
  const p = Math.min(1, Math.max(0, (cur - rise) / (set - rise)));
  const up = cur >= rise && cur <= set;
  const W = 300;
  const H = 70;
  const x = 10 + p * (W - 20);
  const y = H - 8 - Math.sin(p * Math.PI) * (H - 20);
  return (
    <div className="wx-sun">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <path d={`M10 ${H - 8} Q ${W / 2} ${-H + 30} ${W - 10} ${H - 8}`} className="wx-sun-path" />
        <line x1="0" y1={H - 8} x2={W} y2={H - 8} className="wx-sun-horizon" />
        {up && <circle cx={x} cy={y} r="7" className="wx-sun-dot" />}
      </svg>
      <div className="wx-sun-labels">
        <span>
          <Icon name="sunrise" size={14} /> {clockLabel(sunrise)}
        </span>
        <span className="muted small">{up ? `${Math.round((set - cur) / 60)} h of daylight left` : 'After sunset'}</span>
        <span>
          <Icon name="sunset" size={14} /> {clockLabel(sunset)}
        </span>
      </div>
    </div>
  );
}

/** Forecast card for the Home grid: now, hourly strip, daily range bars and a daylight arc. */
export function WeatherCard({ days = 7, hours = 8, showSun = true, fill = false }: { days?: number; hours?: number; showSun?: boolean; fill?: boolean } = {}) {
  const { data, isError } = useWeather();
  if (isError) return null;
  if (!data?.enabled || !data.current) return null;
  const c = data.current;
  const d = describeWeather(c.code, c.isDay);
  const t = today();
  const todayF = data.daily?.[0];
  const moon = moonPhase();
  const nowHour = (c.time ?? '').slice(0, 13);
  const hourly = (data.hourly ?? []).filter((h) => h.time.slice(0, 13) >= nowHour).slice(0, hours);
  const daily = (data.daily ?? []).slice(0, days);
  const lo = Math.min(...daily.map((x) => x.min));
  const hi = Math.max(...daily.map((x) => x.max));
  const span = Math.max(1, hi - lo);
  const speed = data.units === 'fahrenheit' ? 'mph' : 'km/h';
  return (
    <section className={`card wx-card ${fill ? 'widget-fill' : ''}`}>
      <div className={fill ? 'widget-scroll wx-body' : 'wx-body'}>
        <div className="wx-top">
          <span className="wx-card-icon" aria-hidden="true">{d.icon}</span>
          <div className="wx-top-main">
            <div className="wx-card-temp">{deg(c.temp)}</div>
            <div className="wx-cond">{d.label}</div>
            <div className="muted small">{data.location}</div>
          </div>
          <div className="wx-stats">
            <span>Feels like {deg(c.feelsLike)}</span>
            {todayF && (
              <span>
                H {deg(todayF.max)} · L {deg(todayF.min)}
              </span>
            )}
            <span>
              <Icon name="drop" size={13} /> {c.humidity}%
            </span>
            <span>
              <Icon name="wind" size={13} /> {Math.round(c.wind)} {speed}
            </span>
            <span title={`${moon.illumination}% lit`}>
              {moon.icon} {moon.name}
            </span>
          </div>
        </div>

        {hourly.length > 0 && (
          <>
            <div className="wx-section">Next {hourly.length} hours</div>
            <div className="wx-hours">
              {hourly.map((h, i) => {
                const hd = describeWeather(h.code, h.isDay);
                return (
                  <div key={h.time} className={`wx-hour ${i === 0 ? 'is-now' : ''}`} title={hd.label}>
                    <div className="wx-hour-t">{hourLabel(h.time, i === 0)}</div>
                    <div className="wx-hour-i" aria-hidden="true">{hd.icon}</div>
                    <div className="wx-hour-v">{deg(h.temp)}</div>
                    {h.precipChance !== null && h.precipChance >= 20 && <div className="wx-rain">{h.precipChance}%</div>}
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div className="wx-section">{daily.length}-day forecast</div>
        <div className="wx-daily">
          {daily.map((day) => {
            const dd = describeWeather(day.code);
            const left = ((day.min - lo) / span) * 100;
            const width = Math.max(4, ((day.max - day.min) / span) * 100);
            return (
              <div key={day.date} className="wx-drow" title={dd.label}>
                <div className="wx-dname">
                  {day.date === t ? 'Today' : fmtWeekday(day.date)}
                  {day.precipChance !== null && day.precipChance >= 20 && <span className="wx-rain">{day.precipChance}%</span>}
                </div>
                <div className="wx-dicon" aria-hidden="true">{dd.icon}</div>
                <div className="wx-dmin">{deg(day.min)}</div>
                <div className="wx-bar">
                  <span
                    style={{
                      left: `${left}%`,
                      width: `${width}%`,
                      background: `linear-gradient(90deg, ${tempColor(day.min, data.units)}, ${tempColor(day.max, data.units)})`,
                    }}
                  />
                </div>
                <div className="wx-dmax">{deg(day.max)}</div>
              </div>
            );
          })}
        </div>

        {showSun && todayF && <SunArc sunrise={todayF.sunrise} sunset={todayF.sunset} now={c.time} />}
      </div>
    </section>
  );
}

/** Large overlay for the photo slideshow. */
export function SlideWeather() {
  const { data } = useWeather();
  if (!data?.enabled || !data.current) return null;
  const c = data.current;
  const d = describeWeather(c.code, c.isDay);
  const todayF = data.daily?.[0];
  return (
    <div className="slide-weather">
      <span className="slide-weather-icon" aria-hidden="true">{d.icon}</span>
      <div>
        <div className="slide-weather-temp">{deg(c.temp)}</div>
        <div className="slide-weather-sub">
          {d.label}
          {todayF && ` · H ${deg(todayF.max)} L ${deg(todayF.min)}`}
        </div>
      </div>
    </div>
  );
}
