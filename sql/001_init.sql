-- Podcast Studio schema (ps_*) — lives in shared project mgnjlymtjmcoskqinhid,
-- fully separated from the client-inbox tables. Service-role only (RLS on, no policies).

create table if not exists ps_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create table if not exists ps_clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  logo_url text,
  access_key text not null unique,
  descript_token text,               -- per-client Descript Drive API token (entered at onboarding)
  descript_drive_id text,
  descript_drive_name text,
  descript_model text,               -- null = 'auto'
  target_audience text,              -- who the LinkedIn posts speak to
  brand_notes text,                  -- tone/positioning notes fed to post generation
  reel_count int not null default 8, -- how many reels to ask for per episode
  auto_produce boolean not null default false, -- produce new recordings automatically
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists ps_episodes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references ps_clients(id) on delete cascade,
  descript_project_id text not null,
  name text not null,
  folder_path text,
  project_url text,
  status text not null default 'new', -- new | producing | ready | failed
  duration_seconds numeric,
  main_composition_id text,
  main_share_url text,
  main_download_url text,
  main_download_expires_at timestamptz,
  transcript_md text,
  posts_status text not null default 'none', -- none | generating | ready | failed
  error text,
  descript_created_at timestamptz,
  descript_updated_at timestamptz,
  created_at timestamptz not null default now(),
  produced_at timestamptz,
  unique (client_id, descript_project_id)
);
create index if not exists ps_episodes_client_idx on ps_episodes (client_id, created_at desc);

create table if not exists ps_reels (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null references ps_episodes(id) on delete cascade,
  title text,
  composition_id text,
  share_url text,
  download_url text,
  download_expires_at timestamptz,
  status text not null default 'pending', -- pending | publishing | ready | failed
  sort int not null default 0,
  created_at timestamptz not null default now(),
  unique (episode_id, composition_id)
);
create index if not exists ps_reels_episode_idx on ps_reels (episode_id, sort);

create table if not exists ps_posts (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null references ps_episodes(id) on delete cascade,
  hook text,
  body text not null,
  first_comment text,
  status text not null default 'draft', -- draft | approved
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists ps_posts_episode_idx on ps_posts (episode_id, sort);

-- Every unit of async work. Descript jobs are attached where relevant.
create table if not exists ps_jobs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references ps_clients(id) on delete cascade,
  episode_id uuid references ps_episodes(id) on delete cascade,
  kind text not null,   -- produce_main | make_reels | command | generate_posts | publish_reel
  step text not null default 'queued', -- queued | agent_running | publishing | done | failed | cancelled
  descript_job_id text,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  ai_credits_used numeric,
  media_seconds_used numeric,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ps_jobs_active_idx on ps_jobs (step) where step not in ('done','failed','cancelled');
create index if not exists ps_jobs_episode_idx on ps_jobs (episode_id, created_at desc);

-- Chat history between the client and the AI (each row usually maps to one command job)
create table if not exists ps_commands (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null references ps_episodes(id) on delete cascade,
  client_id uuid not null references ps_clients(id) on delete cascade,
  target text,          -- 'main' or a reel composition_id
  text text not null,
  status text not null default 'working', -- working | done | failed
  agent_response text,
  job_id uuid references ps_jobs(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists ps_commands_episode_idx on ps_commands (episode_id, created_at);

create table if not exists ps_events (
  id bigint generated always as identity primary key,
  event_type text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);

alter table ps_config enable row level security;
alter table ps_clients enable row level security;
alter table ps_episodes enable row level security;
alter table ps_reels enable row level security;
alter table ps_posts enable row level security;
alter table ps_jobs enable row level security;
alter table ps_commands enable row level security;
alter table ps_events enable row level security;
