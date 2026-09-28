/** Home page layout model shared by the Home page, its editor and the theme. */
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from './api';

export type WidgetType = 'header' | 'weather' | 'cameras' | 'agenda' | 'chores' | 'meals' | 'shopping' | 'todos' | 'clock' | 'note';

export interface Widget {
  id: string;
  type: WidgetType;
  /** Width in columns of a 12-column grid. */
  w: number;
  /** Height in grid rows. */
  h: number;
  hidden?: boolean;
  options?: Record<string, string | number | boolean>;
}

export interface Theme {
  accent?: string;
  mode?: 'auto' | 'light' | 'dark';
  scale?: 'sm' | 'md' | 'lg' | 'xl';
  background?: 'plain' | 'warm' | 'sky' | 'forest' | 'dusk';
  density?: 'cozy' | 'compact';
}

export interface HomeLayout {
  version: 1;
  widgets: Widget[];
  theme: Theme;
}

export interface OptionSpec {
  key: string;
  label: string;
  kind: 'select' | 'text' | 'textarea' | 'bool' | 'list';
  options?: { value: string; label: string }[];
  def: string | number | boolean;
}

export interface WidgetSpec {
  type: WidgetType;
  label: string;
  icon: string;
  description: string;
  w: number;
  h: number;
  minW: number;
  minH: number;
  /** Several of these can be added (e.g. notes). */
  multiple?: boolean;
  options?: OptionSpec[];
}

export const WIDGETS: WidgetSpec[] = [
  {
    type: 'header',
    label: 'Greeting & clock',
    icon: 'home',
    description: 'Greeting, date, time, current weather and the Photos button',
    w: 12,
    h: 2,
    minW: 4,
    minH: 1,
    options: [
      { key: 'greeting', label: 'Show greeting', kind: 'bool', def: true },
      { key: 'weather', label: 'Show current weather', kind: 'bool', def: true },
      { key: 'clock', label: 'Show clock', kind: 'bool', def: true },
    ],
  },
  {
    type: 'clock',
    label: 'Big clock',
    icon: 'sun',
    description: 'A large clock and date',
    w: 4,
    h: 3,
    minW: 2,
    minH: 2,
    options: [{ key: 'seconds', label: 'Show seconds', kind: 'bool', def: false }],
  },
  {
    type: 'weather',
    label: 'Weather',
    icon: 'sun',
    description: 'Current conditions and forecast',
    w: 4,
    h: 4,
    minW: 2,
    minH: 2,
    options: [
      {
        key: 'days',
        label: 'Forecast days',
        kind: 'select',
        def: '6',
        options: ['3', '5', '6', '7', '10', '14'].map((d) => ({ value: d, label: `${d} days` })),
      },
    ],
  },
  { type: 'cameras', label: 'Cameras', icon: 'camera', description: 'UniFi Protect cameras', w: 12, h: 5, minW: 3, minH: 3 },
  {
    type: 'agenda',
    label: 'Coming up',
    icon: 'calendar',
    description: 'Upcoming calendar events',
    w: 4,
    h: 8,
    minW: 3,
    minH: 3,
    options: [
      { key: 'days', label: 'Show the next', kind: 'select', def: '7', options: ['1', '3', '7', '14'].map((d) => ({ value: d, label: d === '1' ? 'Today only' : `${d} days` })) },
      { key: 'title', label: 'Title', kind: 'text', def: 'Coming up' },
    ],
  },
  {
    type: 'chores',
    label: "Today's chores",
    icon: 'star',
    description: 'Chores due today, by person',
    w: 4,
    h: 5,
    minW: 3,
    minH: 2,
    options: [{ key: 'hideDone', label: 'Hide finished chores', kind: 'bool', def: false }],
  },
  { type: 'meals', label: "Today's meals", icon: 'meal', description: 'What’s cooking today', w: 4, h: 3, minW: 2, minH: 2 },
  {
    type: 'shopping',
    label: 'Shopping list',
    icon: 'cart',
    description: 'Items still to buy',
    w: 4,
    h: 4,
    minW: 2,
    minH: 2,
    multiple: true,
    options: [
      { key: 'listId', label: 'List', kind: 'list', def: '' },
      { key: 'max', label: 'Items to show', kind: 'select', def: '8', options: ['5', '8', '12', '20', '50'].map((n) => ({ value: n, label: n })) },
    ],
  },
  { type: 'todos', label: 'To-dos', icon: 'list', description: 'Open to-do items from all lists', w: 4, h: 4, minW: 2, minH: 2 },
  {
    type: 'note',
    label: 'Family note',
    icon: 'edit',
    description: 'A sticky note for everyone to see',
    w: 4,
    h: 3,
    minW: 2,
    minH: 1,
    multiple: true,
    options: [
      { key: 'text', label: 'Note', kind: 'textarea', def: 'Welcome home! 👋' },
      {
        key: 'color',
        label: 'Colour',
        kind: 'select',
        def: 'yellow',
        options: [
          { value: 'yellow', label: 'Yellow' },
          { value: 'pink', label: 'Pink' },
          { value: 'blue', label: 'Blue' },
          { value: 'green', label: 'Green' },
        ],
      },
    ],
  },
];

export const specFor = (t: WidgetType) => WIDGETS.find((w) => w.type === t)!;

export function optionValue(w: Widget, key: string) {
  const spec = specFor(w.type).options?.find((o) => o.key === key);
  const v = w.options?.[key];
  return v === undefined ? spec?.def : v;
}

export const BUILTIN_LAYOUT: HomeLayout = {
  version: 1,
  theme: { mode: 'auto', scale: 'md', background: 'plain', density: 'cozy' },
  widgets: [
    { id: 'header', type: 'header', w: 12, h: 2 },
    { id: 'cameras', type: 'cameras', w: 12, h: 5 },
    { id: 'agenda', type: 'agenda', w: 4, h: 9 },
    { id: 'weather', type: 'weather', w: 4, h: 4 },
    { id: 'chores', type: 'chores', w: 4, h: 5 },
    { id: 'meals', type: 'meals', w: 4, h: 3 },
    { id: 'shopping', type: 'shopping', w: 4, h: 5 },
    { id: 'todos', type: 'todos', w: 4, h: 4 },
  ],
};

export interface LayoutResponse {
  layout: HomeLayout | null;
  source: 'mine' | 'family' | 'builtin';
  familyDefault: HomeLayout | null;
}

export function useHomeLayout(enabled = true) {
  return useQuery({
    queryKey: ['home-layout'],
    queryFn: () => api<LayoutResponse>('/home/layout'),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function resolveLayout(r: LayoutResponse | undefined): HomeLayout {
  return r?.layout ?? BUILTIN_LAYOUT;
}

export const ACCENTS = ['#e8664a', '#5b7cfa', '#2bb673', '#a65bfa', '#ec5fa8', '#1fb5c9', '#f5a623', '#607080'];

/** Apply a theme to the whole app (accent + light/dark). Home-only bits (background, text size) are applied by the Home page. */
export function applyTheme(theme: Theme | undefined) {
  const root = document.documentElement;
  const mode = theme?.mode ?? 'auto';
  if (mode === 'auto') root.removeAttribute('data-mode');
  else root.setAttribute('data-mode', mode);
  if (theme?.accent) root.style.setProperty('--accent', theme.accent);
  else root.style.removeProperty('--accent');
}

export function useApplyTheme(theme: Theme | undefined) {
  useEffect(() => {
    applyTheme(theme);
  }, [theme?.accent, theme?.mode]); // eslint-disable-line react-hooks/exhaustive-deps
}

export const newId = () => Math.random().toString(36).slice(2, 10);
