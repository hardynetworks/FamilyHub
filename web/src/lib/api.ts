export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export async function api<T = any>(path: string, method: Method = 'GET', body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET' && method !== 'DELETE') {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(`/api${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  return data as T;
}

export const qs = (params: Record<string, string | undefined>) =>
  '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]).toString();

// ---------- Types ----------
export interface Member {
  id: string;
  name: string;
  email: string | null;
  role: 'admin' | 'member';
  color: string;
  avatar: string | null;
  canLogin: boolean;
  hasPassword: boolean;
  linkedSso: boolean;
}

export interface AuthStatus {
  appName: string;
  user: Member | null;
  needsSetup: boolean;
  localLogin: boolean;
  oidc: { enabled: boolean; label: string };
  google: { enabled: boolean };
  timezone: string;
}

export interface CalEvent {
  id: string;
  instanceKey: string;
  title: string;
  description: string | null;
  location: string | null;
  start: string;
  end: string;
  seriesStart: string;
  seriesEnd: string;
  allDay: boolean;
  rrule: string | null;
  memberIds: string[];
  color: string | null;
  calendarId: string | null;
  calendarName: string | null;
  calendarColor: string | null;
  source: 'local' | 'google';
  isGoogleRecurringInstance: boolean;
  editable: boolean;
}

export interface CalendarTarget {
  id: string;
  name: string;
  account: string;
  color: string | null;
  memberId: string | null;
}

export interface List {
  id: string;
  name: string;
  kind: 'shopping' | 'todo';
  emoji: string | null;
  sort: number;
  openCount: number;
  totalCount: number;
}

export interface ListItem {
  id: string;
  listId: string;
  text: string;
  checked: boolean;
  assigneeId: string | null;
  dueDate: string | null;
  sort: number;
  listName?: string;
}

export interface Chore {
  id: string;
  title: string;
  emoji: string | null;
  assigneeId: string | null;
  points: number;
  frequency: 'once' | 'daily' | 'weekly';
  daysOfWeek: number[];
  dueDate: string | null;
  active: boolean;
  done?: boolean;
  completedBy?: string | null;
}

export interface Recipe {
  id: string;
  title: string;
  ingredients: string[];
  instructions: string | null;
  sourceUrl: string | null;
  servings: number | null;
  prepMinutes: number | null;
  tags: string[];
}

export type Slot = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export interface Meal {
  id: string;
  date: string;
  slot: Slot;
  recipeId: string | null;
  recipeTitle: string | null;
  title: string | null;
  notes: string | null;
}

export interface GoogleStatus {
  enabled: boolean;
  redirectUri: string;
  intervalMinutes: number;
  connections: {
    id: string;
    googleEmail: string;
    userId: string;
    userName: string;
    error: string | null;
    calendars: {
      id: string;
      name: string;
      color: string | null;
      accessRole: string;
      primary: boolean;
      syncEnabled: boolean;
      memberId: string | null;
      lastSyncedAt: string | null;
      error: string | null;
    }[];
  }[];
}

export interface SettingField {
  value?: string | number | boolean;
  isSet?: boolean;
  secret: boolean;
  lockedByEnv: boolean;
  env: string;
}

export interface AdminSettings {
  settings: Record<string, SettingField>;
  detectedUrl: string;
  effective: { baseUrl: string; localLogin: boolean; oidcEnabled: boolean; googleEnabled: boolean; timezone: string };
  redirectUris: { oidc: string; google: string };
  dataDir: string;
}
