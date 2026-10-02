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
  memberType: 'adult' | 'child';
  hasPassword: boolean;
  linkedSso: boolean;
  prefs: { slideshowEnabled: boolean; slideshowIdleMinutes: number; camerasMode: CamerasMode | 'default'; doorbellPopup: boolean; notifyEmail: boolean; notifyText: string; remindPush: boolean; remindEmail: boolean };
}

export type CamerasMode = 'off' | 'snapshots' | 'live' | 'snapshots_live';

export interface CameraInfo {
  id: string;
  name: string;
  state: string;
  model: string | null;
  isDoorbell: boolean;
}

export interface CameraList {
  enabled: boolean;
  mode?: CamerasMode;
  snapshotSeconds: number;
  liveAvailable?: boolean;
  doorbell?: { enabled: boolean; seconds: number };
  cameras: CameraInfo[];
  error?: string;
}

export interface WeatherData {
  enabled: boolean;
  location?: string;
  units?: 'fahrenheit' | 'celsius';
  current?: { temp: number; feelsLike: number; code: number; isDay: boolean; wind: number; humidity: number; time: string; uv?: number | null };
  hourly?: { time: string; temp: number; code: number; isDay: boolean; precipChance: number | null }[];
  daily?: { date: string; code: number; max: number; min: number; precipChance: number | null; sunrise: string; sunset: string }[];
  updatedAt?: string;
}

export interface PhotoList {
  enabled: boolean;
  slideSeconds: number;
  photos: { id: string; takenAt: string | null; width?: number; height?: number }[];
  errors?: string[];
}

export interface AuthStatus {
  appName: string;
  familyName?: string;
  user: Member | null;
  needsSetup: boolean;
  localLogin: boolean;
  oidc: { enabled: boolean; label: string };
  google: { enabled: boolean };
  timezone: string;
  /** Changes when the server restarts; kiosk screens reload when it does. */
  version?: string;
  /** Set when this browser is a paired kiosk screen. */
  device?: KioskDevice | null;
  kioskPinSet?: boolean;
}

export type KioskPage = 'calendar' | 'lists' | 'chores' | 'meals' | 'info';
export interface KioskOptions {
  pages: KioskPage[];
  returnHomeSeconds: number;
  hideCursor: boolean;
  reloadNightly: boolean;
  /** Family group shown on the screen (null = the whole family). */
  groupId: string | null;
}
export interface KioskDevice {
  id: string;
  name: string;
  options: KioskOptions;
  /** The family group the screen shows (kiosk screens only). */
  group?: { id: string; name: string; emoji: string | null; color: string } | null;
}
export interface FamilyGroup {
  id: string;
  name: string;
  emoji: string | null;
  color: string;
  sort: number;
  memberIds: string[];
}
export interface AdminDevice extends KioskDevice {
  userId: string;
  paired: boolean;
  pairingOpen: boolean;
  pairExpires: string | null;
  pairedAt: string | null;
  lastSeen: string | null;
  lastIp: string | null;
  userAgent: string | null;
  createdAt: string;
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
  source: 'local' | 'google' | 'icloud' | 'caldav' | 'ics' | 'occasion';
  isGoogleRecurringInstance: boolean;
  editable: boolean;
  /** Minutes before the start to send a reminder (null = none). */
  reminderMinutes: number | null;
}

export interface CalendarTarget {
  id: string;
  name: string;
  account: string;
  color: string | null;
  memberId: string | null;
  provider?: string;
}

export interface Occasion {
  id: string;
  title: string;
  kind: 'birthday' | 'anniversary' | 'other';
  month: number;
  day: number;
  year: number | null;
  memberId: string | null;
  emoji: string;
  customEmoji: string | null;
  remindDays: number;
  label: string;
  next: string;
  daysUntil: number;
  years: number | null;
  yearsLabel: string;
}

export interface Reward {
  id: string;
  title: string;
  emoji: string | null;
  cost: number;
  active: boolean;
}
export interface RewardBalance {
  memberId: string;
  earned: number;
  balance: number;
  pending: number;
  available: number;
}
export interface RewardsData {
  pointsPerDollar: number;
  rewards: Reward[];
  balances: RewardBalance[];
  pending: { id: string; memberId: string; title: string; emoji: string | null; cost: number; requestedAt: string }[];
  history: { kind: string; memberId: string; title: string; emoji: string | null; points: number; status: string | null; at: string }[];
}

export interface WifiNetwork {
  label: string;
  ssid: string;
  password: string;
  security: 'WPA' | 'WEP' | 'nopass';
  hidden: boolean;
}
export type ContactCategory = 'emergency' | 'family' | 'doctor' | 'dentist' | 'school' | 'work' | 'vet' | 'other';
export interface InfoContact {
  category: ContactCategory;
  name: string;
  role: string;
  phone: string;
  email: string;
  notes: string;
}
export interface MedicalInfo {
  memberId: string;
  allergies: string;
  medications: string;
  conditions: string;
  bloodType: string;
  notes: string;
}
export interface FamilyInfo {
  wifi: WifiNetwork[];
  address: string;
  contacts: InfoContact[];
  medical: MedicalInfo[];
  notes: string;
  updatedAt?: string | null;
}

export interface ExtCalendarAccount {
  id: string;
  kind: 'caldav' | 'ics';
  provider: string;
  name: string;
  url: string;
  username: string | null;
  userId: string | null;
  canEdit: boolean;
  lastError: string | null;
  calendars: { id: string; name: string; color: string | null; writable: boolean; syncEnabled: boolean; memberId: string | null; lastSyncedAt: string | null; lastError: string | null }[];
}

export interface BackupsData {
  backups: { name: string; size: number; createdAt: string }[];
  folder: string;
  writable: boolean;
  busy: boolean;
  lastError: string | null;
  lastRun: string | null;
  time: string;
  keep: number;
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

export type Priority = 'none' | 'low' | 'medium' | 'high';

export interface ListItem {
  id: string;
  listId: string;
  text: string;
  checked: boolean;
  assigneeId: string | null;
  dueDate: string | null;
  sort: number;
  priority?: Priority;
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
  /** approved | pending (waiting for a parent) | rejected (sent back) | null (not done) */
  status?: 'approved' | 'pending' | 'rejected' | null;
  completedBy?: string | null;
}

export interface ChoreApproval {
  id: string;
  date: string;
  completedBy: string | null;
  completedAt: string;
  points: number;
  title: string;
  emoji: string | null;
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
