-- ============================================================================
-- Phase 5: Database Foundation
-- Tables: profiles, projects, reddit_leads, sync_logs, subscriptions
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- Shared trigger function to keep updated_at current on every UPDATE.
-- Defined once and reused by all tables below.
-- ----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================================
-- profiles
-- One row per auth user. id is intentionally NOT gen_random_uuid()-defaulted;
-- it mirrors auth.users(id) 1:1 so RLS can compare auth.uid() = id directly,
-- and so a profile can never exist without a corresponding auth user.
-- ============================================================================
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_email_unique unique (email)
);

comment on table public.profiles is 'One row per authenticated user, keyed to auth.users(id).';

create index profiles_email_idx on public.profiles (email);

create trigger set_profiles_updated_at
  before update on public.profiles
  for each row
  execute function public.set_updated_at();

alter table public.profiles enable row level security;

create policy profiles_select_own
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id);

create policy profiles_insert_own
  on public.profiles for insert
  to authenticated
  with check ((select auth.uid()) = id);

create policy profiles_update_own
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

create policy profiles_delete_own
  on public.profiles for delete
  to authenticated
  using ((select auth.uid()) = id);

-- ----------------------------------------------------------------------------
-- Auto-create a profiles row whenever a new auth user signs up.
-- security definer + fixed search_path so it can insert into public.profiles
-- regardless of the calling role, without being hijackable via search_path.
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- ============================================================================
-- projects
-- A project represents a set of keywords/subreddits a user monitors.
-- ============================================================================
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  description text,
  keywords text[] not null default '{}',
  subreddits text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_user_name_unique unique (user_id, name)
);

comment on table public.projects is 'A monitored project (keywords + subreddits) owned by a user.';
comment on constraint projects_user_name_unique on public.projects is 'Prevents a user from creating two projects with the same name.';

create index projects_user_id_idx on public.projects (user_id);
create index projects_user_active_idx on public.projects (user_id, is_active);

create trigger set_projects_updated_at
  before update on public.projects
  for each row
  execute function public.set_updated_at();

alter table public.projects enable row level security;

create policy projects_select_own
  on public.projects for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy projects_insert_own
  on public.projects for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy projects_update_own
  on public.projects for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy projects_delete_own
  on public.projects for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ============================================================================
-- reddit_leads
-- Leads discovered by scanning Reddit for a project's keywords/subreddits.
-- user_id is denormalized from projects so RLS can filter without a join.
-- ============================================================================
create table public.reddit_leads (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  reddit_post_id text not null,
  subreddit text not null,
  title text not null,
  content text,
  author text,
  url text,
  score integer not null default 0,
  matched_keywords text[] not null default '{}',
  status text not null default 'new',
  post_created_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reddit_leads_project_post_unique unique (project_id, reddit_post_id),
  constraint reddit_leads_status_check check (status in ('new', 'reviewed', 'contacted', 'ignored'))
);

comment on table public.reddit_leads is 'Reddit posts matched to a project via keyword/subreddit monitoring.';
comment on constraint reddit_leads_project_post_unique on public.reddit_leads is 'Prevents the same Reddit post being ingested twice for the same project.';

create index reddit_leads_project_id_idx on public.reddit_leads (project_id);
create index reddit_leads_user_id_idx on public.reddit_leads (user_id);
create index reddit_leads_project_created_idx on public.reddit_leads (project_id, created_at desc);
create index reddit_leads_status_idx on public.reddit_leads (status);

create trigger set_reddit_leads_updated_at
  before update on public.reddit_leads
  for each row
  execute function public.set_updated_at();

alter table public.reddit_leads enable row level security;

create policy reddit_leads_select_own
  on public.reddit_leads for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy reddit_leads_insert_own
  on public.reddit_leads for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy reddit_leads_update_own
  on public.reddit_leads for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy reddit_leads_delete_own
  on public.reddit_leads for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ============================================================================
-- sync_logs
-- Audit trail of each sync/scan run for a project.
-- ============================================================================
create table public.sync_logs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'running',
  leads_found integer not null default 0,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sync_logs_status_check check (status in ('running', 'success', 'failed'))
);

comment on table public.sync_logs is 'Audit trail of Reddit sync/scan runs per project.';

create index sync_logs_project_id_idx on public.sync_logs (project_id);
create index sync_logs_user_id_idx on public.sync_logs (user_id);
create index sync_logs_project_started_idx on public.sync_logs (project_id, started_at desc);

create trigger set_sync_logs_updated_at
  before update on public.sync_logs
  for each row
  execute function public.set_updated_at();

alter table public.sync_logs enable row level security;

create policy sync_logs_select_own
  on public.sync_logs for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy sync_logs_insert_own
  on public.sync_logs for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy sync_logs_update_own
  on public.sync_logs for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy sync_logs_delete_own
  on public.sync_logs for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ============================================================================
-- subscriptions
-- One active billing subscription per user (MVP assumption: single plan).
--
-- Write access (INSERT/UPDATE/DELETE) is intentionally NOT granted to the
-- authenticated role. Subscription state must only ever be mutated by the
-- backend payment webhook handler using the service_role key, which bypasses
-- RLS entirely by default in Supabase. Authenticated users get read-only
-- access to their own row so the app can display plan/status info.
--
-- payment_provider + provider_customer_id/provider_subscription_id are kept
-- generic (rather than Stripe-specific) so the table can support Dodo
-- Payments now and other providers later without a schema change.
-- ============================================================================
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  payment_provider text not null default 'dodo',
  provider_customer_id text,
  provider_subscription_id text,
  plan text not null default 'free',
  status text not null default 'active',
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscriptions_user_unique unique (user_id),
  constraint subscriptions_provider_customer_unique unique (provider_customer_id),
  constraint subscriptions_provider_subscription_unique unique (provider_subscription_id),
  constraint subscriptions_status_check check (
    status in ('active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired')
  )
);

comment on table public.subscriptions is 'Billing subscription state per user, synced from the payment provider via service-role webhook only.';
comment on constraint subscriptions_user_unique on public.subscriptions is 'MVP assumption: a user has at most one subscription.';

create index subscriptions_user_id_idx on public.subscriptions (user_id);
create index subscriptions_provider_customer_idx on public.subscriptions (provider_customer_id);

create trigger set_subscriptions_updated_at
  before update on public.subscriptions
  for each row
  execute function public.set_updated_at();

alter table public.subscriptions enable row level security;

-- Read-only for authenticated users; no insert/update/delete policies are
-- defined here on purpose. Writes come only from the service role, which
-- bypasses RLS, so no explicit service_role policy is required either.
create policy subscriptions_select_own
  on public.subscriptions for select
  to authenticated
  using ((select auth.uid()) = user_id);
