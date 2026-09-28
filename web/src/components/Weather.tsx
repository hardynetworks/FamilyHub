import { useQuery } from '@tanstack/react-query';
import { WeatherData, api } from '../lib/api';
import { fmtWeekday, today } from '../lib/dates';

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

/** Forecast card for the Home grid. */
export function WeatherCard({ days = 6, fill = false }: { days?: number; fill?: boolean } = {}) {
  const { data, isError } = useWeather();
  if (isError) return null;
  if (!data?.enabled || !data.current) return null;
  const c = data.current;
  const d = describeWeather(c.code, c.isDay);
  const t = today();
  return (
    <section className={`card wx-card ${fill ? 'widget-fill' : ''}`}>
      <div className="card-head">
        <h2>Weather</h2>
        <span className="muted small">{data.location}</span>
      </div>
      <div className="wx-card-now">
        <span className="wx-card-icon" aria-hidden="true">{d.icon}</span>
        <div>
          <div className="wx-card-temp">{deg(c.temp)}</div>
          <div className="muted small">
            {d.label} · Feels like {deg(c.feelsLike)}
          </div>
          <div className="muted small">
            Humidity {c.humidity}% · Wind {Math.round(c.wind)} {data.units === 'fahrenheit' ? 'mph' : 'km/h'}
          </div>
        </div>
      </div>
      <div className="wx-days">
        {(data.daily ?? []).slice(0, days).map((day) => {
          const dd = describeWeather(day.code);
          return (
            <div key={day.date} className="wx-day" title={dd.label}>
              <div className="wx-day-name">{day.date === t ? 'Today' : fmtWeekday(day.date)}</div>
              <div className="wx-day-icon" aria-hidden="true">{dd.icon}</div>
              <div className="wx-day-temps">
                <strong>{deg(day.max)}</strong> <span className="muted">{deg(day.min)}</span>
              </div>
              {day.precipChance !== null && day.precipChance >= 20 && <div className="wx-day-rain">💧{day.precipChance}%</div>}
            </div>
          );
        })}
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
