import { pool } from './db';

// Append-only list of migrations. Never edit a migration that has shipped; add a new one.
export const migrations: { id: string; sql: string }[] = [
  {
    id: '001_init',
    sql: `
create table users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  password_hash text,
  oidc_sub text unique,
  role text not null default 'member' check (role in ('admin','member')),
  color text not null default '#5b7cfa',
  avatar text,
  can_login boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index users_email_lower_idx on users (lower(email)) where email is not null;

create table settings (
  key text primary key,
  value jsonb not null
);

create table google_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  google_email text not null,
  refresh_token_enc text not null,
  access_token_enc text,
  access_token_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (user_id, google_email)
);

create table google_calendars (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references google_connections(id) on delete cascade,
  google_calendar_id text not null,
  summary text not null,
  background_color text,
  access_role text not null default 'reader',
  is_primary boolean not null default false,
  sync_enabled boolean not null default false,
  member_id uuid references users(id) on delete set null,
  last_synced_at timestamptz,
  last_error text,
  unique (connection_id, google_calendar_id)
);

create table events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  location text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  all_day boolean not null default false,
  rrule text,
  member_ids uuid[] not null default '{}',
  color text,
  calendar_id uuid references google_calendars(id) on delete cascade,
  google_event_id text,
  google_etag text,
  google_recurring_event_id text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (calendar_id, google_event_id)
);
create index events_start_idx on events (start_at);
create index events_end_idx on events (end_at);
create index events_calendar_idx on events (calendar_id);

create table lists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null default 'todo' check (kind in ('shopping','todo')),
  emoji text,
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table list_items (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references lists(id) on delete cascade,
  text text not null,
  checked boolean not null default false,
  assignee_id uuid references users(id) on delete set null,
  due_date date,
  sort double precision not null default 0,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  checked_at timestamptz
);
create index list_items_list_idx on list_items (list_id);

create table chores (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  emoji text,
  assignee_id uuid references users(id) on delete set null,
  points int not null default 1,
  frequency text not null default 'daily' check (frequency in ('once','daily','weekly')),
  days_of_week int[] not null default '{}',
  due_date date,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table chore_completions (
  id uuid primary key default gen_random_uuid(),
  chore_id uuid not null references chores(id) on delete cascade,
  date date not null,
  completed_by uuid references users(id) on delete set null,
  points int not null default 0,
  completed_at timestamptz not null default now(),
  unique (chore_id, date)
);

create table recipes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  ingredients text[] not null default '{}',
  instructions text,
  source_url text,
  servings int,
  prep_minutes int,
  tags text[] not null default '{}',
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table meal_plan (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  slot text not null check (slot in ('breakfast','lunch','dinner','snack')),
  recipe_id uuid references recipes(id) on delete set null,
  title text,
  notes text,
  created_at timestamptz not null default now()
);
create index meal_plan_date_idx on meal_plan (date);

insert into lists (name, kind, emoji, sort) values ('Groceries', 'shopping', '🛒', 0), ('To-Do', 'todo', '✅', 1);
`,
  },
  {
    id: '002_user_prefs',
    sql: `alter table users add column prefs jsonb not null default '{}'::jsonb;`,
  },
  {
    id: '003_member_type',
    sql: `
alter table users add column member_type text not null default 'adult' check (member_type in ('adult','child'));
update users set member_type = 'child' where not can_login and role = 'member';
`,
  },
  {
    id: '004_devices',
    sql: `
create table devices (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  user_id uuid not null references users(id) on delete cascade,
  token_hash text unique,
  pair_code_hash text unique,
  pair_expires timestamptz,
  options jsonb not null default '{}'::jsonb,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  paired_at timestamptz,
  last_seen timestamptz,
  last_ip text,
  user_agent text
);
`,
  },
  {
    id: '005_item_priority',
    sql: `alter table list_items add column priority text not null default 'none' check (priority in ('none','low','medium','high'));`,
  },
];

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock(727274)');
    await client.query(`create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())`);
    const done = new Set((await client.query('select id from schema_migrations')).rows.map((r: any) => r.id));
    for (const m of migrations) {
      if (done.has(m.id)) continue;
      console.log(`Applying migration ${m.id}`);
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('insert into schema_migrations (id) values ($1)', [m.id]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
}
