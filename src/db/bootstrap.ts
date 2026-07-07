/**
 * Idempotent bootstrap SQL that shapes a fresh PGlite database like a
 * Supabase project: roles, auth schema, storage schema, helper functions,
 * migration bookkeeping, and the realtime CDC plumbing.
 */
/**
 * Reduced bootstrap for subset engines (pg-mem) that can't run plpgsql, RLS
 * policies, extensions, or LISTEN/NOTIFY. Just the schemas, core tables, and
 * SQL-language auth helpers needed for the REST + auth CRUD surface. No RLS is
 * enforced here — this path is for local-dev/preview only.
 */
export const MINIMAL_BOOTSTRAP_SQL = `
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists supabase_migrations;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  aud text default 'authenticated',
  role text default 'authenticated',
  email text unique,
  encrypted_password text,
  email_confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb,
  is_super_admin boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  phone text unique,
  phone_confirmed_at timestamptz,
  banned_until timestamptz,
  deleted_at timestamptz,
  is_anonymous boolean default false
);

create table if not exists auth.refresh_tokens (
  id bigserial primary key,
  token text unique not null,
  user_id uuid not null,
  parent text,
  session_id uuid,
  revoked boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists auth.one_time_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  email text not null,
  token_type text not null,
  token text not null,
  created_at timestamptz default now(),
  expires_at timestamptz not null
);

create table if not exists auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  provider text not null,
  provider_id text not null,
  identity_data jsonb default '{}'::jsonb,
  last_sign_in_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (provider, provider_id)
);

create table if not exists auth.flow_state (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_state text not null unique,
  redirect_to text,
  code_challenge text,
  code_challenge_method text,
  auth_code text unique,
  user_id uuid,
  created_at timestamptz default now(),
  expires_at timestamptz not null
);

create table if not exists auth.mfa_factors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  friendly_name text,
  factor_type text not null default 'totp',
  status text not null default 'unverified',
  secret text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists auth.mfa_challenges (
  id uuid primary key default gen_random_uuid(),
  factor_id uuid not null,
  verified_at timestamptz,
  created_at timestamptz default now(),
  expires_at timestamptz not null
);

create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  owner uuid,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null,
  name text not null,
  owner uuid,
  version text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now(),
  unique (bucket_id, name)
);

create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  name text,
  statements text[],
  applied_at timestamptz default now()
);

create table if not exists supabase_migrations.seed_files (
  path text primary key,
  hash text,
  applied_at timestamptz default now()
);
`

export const BOOTSTRAP_SQL = `
-- ── Extensions ─────────────────────────────────────────────────────────────
-- Supabase enables these by default and migrations lean on them
-- (uuid_generate_v4(), crypt(), citext, pg_trgm, …). Each is created into the
-- 'extensions' schema like hosted Supabase; any not available in this engine
-- build is skipped rather than aborting the whole bootstrap.
create schema if not exists extensions;
do $$
declare ext text;
begin
  foreach ext in array array['uuid-ossp','pgcrypto','citext','pg_trgm','ltree','hstore','fuzzystrmatch'] loop
    begin
      execute format('create extension if not exists %I with schema extensions', ext);
    exception when others then
      -- extension not bundled in this engine build; continue
    end;
  end loop;
end $$;

-- uuid-ossp isn't in every Postgres build (it needs an external UUID lib at
-- build time — e.g. the theseus Linux binaries omit it). uuid_generate_v4() is
-- the single most-used function from it, so shim it onto core gen_random_uuid()
-- (also a v4 UUID) whenever the real extension isn't present, so migrations
-- that call it work identically on every engine and platform.
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'uuid_generate_v4' and n.nspname in ('public', 'extensions')
  ) then
    create function extensions.uuid_generate_v4() returns uuid
      language sql volatile as 'select gen_random_uuid()';
  end if;
end $$;

-- Make extension functions resolvable unqualified (uuid_generate_v4(), …) on
-- the current session (migrations run here) and for future connections.
do $$
begin
  execute 'alter database ' || quote_ident(current_database()) ||
          ' set search_path to "$user", public, extensions';
exception when others then
  -- some engines disallow altering the current database; session SET below still applies
end $$;
set search_path to "$user", public, extensions;

-- ── Roles ────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

grant usage on schema extensions to anon, authenticated, service_role;
alter role anon set search_path to "$user", public, extensions;
alter role authenticated set search_path to "$user", public, extensions;
alter role service_role set search_path to "$user", public, extensions;

grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;

alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;

-- ── Auth schema (GoTrue-compatible subset) ───────────────────────────────
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  aud text default 'authenticated',
  role text default 'authenticated',
  email text unique,
  encrypted_password text,
  email_confirmed_at timestamptz,
  invited_at timestamptz,
  confirmation_token text,
  recovery_token text,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb,
  is_super_admin boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  phone text unique,
  phone_confirmed_at timestamptz,
  banned_until timestamptz,
  deleted_at timestamptz,
  is_anonymous boolean default false
);

create table if not exists auth.refresh_tokens (
  id bigint generated by default as identity primary key,
  token text unique not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  parent text,
  session_id uuid,
  revoked boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists refresh_tokens_user_id_idx on auth.refresh_tokens(user_id);

create table if not exists auth.one_time_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  email text not null,
  token_type text not null, -- otp | magiclink | recovery
  token text not null,
  created_at timestamptz default now(),
  expires_at timestamptz not null
);

create table if not exists auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  provider_id text not null,
  identity_data jsonb default '{}'::jsonb,
  last_sign_in_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (provider, provider_id)
);

-- OAuth / PKCE flow state, bridging /authorize → provider → /callback → exchange
create table if not exists auth.flow_state (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_state text not null unique,
  redirect_to text,
  code_challenge text,
  code_challenge_method text,
  auth_code text unique,
  user_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz default now(),
  expires_at timestamptz not null
);

create table if not exists auth.mfa_factors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  friendly_name text,
  factor_type text not null default 'totp',
  status text not null default 'unverified', -- unverified | verified
  secret text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists auth.mfa_challenges (
  id uuid primary key default gen_random_uuid(),
  factor_id uuid not null references auth.mfa_factors(id) on delete cascade,
  verified_at timestamptz,
  created_at timestamptz default now(),
  expires_at timestamptz not null
);

grant usage on schema auth to anon, authenticated, service_role;

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), ''),
    '{}'
  )::jsonb
$$;

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(auth.jwt() ->> 'role', 'anon')
$$;

create or replace function auth.email() returns text
language sql stable as $$
  select auth.jwt() ->> 'email'
$$;

grant execute on function auth.jwt(), auth.uid(), auth.role(), auth.email()
  to anon, authenticated, service_role;

-- ── Storage schema (storage-api-compatible subset) ───────────────────────
create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  owner uuid,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id),
  name text not null,
  owner uuid,
  version text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now(),
  unique (bucket_id, name)
);

create index if not exists objects_bucket_name_idx on storage.objects(bucket_id, name);

grant usage on schema storage to anon, authenticated, service_role;
grant select on storage.buckets to anon, authenticated, service_role;
grant all on storage.buckets to service_role;
grant all on storage.objects to anon, authenticated, service_role;

create or replace function storage.foldername(name text) returns text[]
language sql immutable as $$
  select (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1]
$$;

create or replace function storage.filename(name text) returns text
language sql immutable as $$
  select (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)]
$$;

create or replace function storage.extension(name text) returns text
language sql immutable as $$
  select reverse(split_part(reverse(storage.filename(name)), '.', 1))
$$;

alter table storage.objects enable row level security;

-- Dev-friendly default policies. Replace them in your migrations to lock down.
do $$
begin
  if not exists (select from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'tinbase_authenticated_all') then
    create policy tinbase_authenticated_all on storage.objects
      for all to authenticated using (true) with check (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'tinbase_public_read') then
    create policy tinbase_public_read on storage.objects
      for select to anon
      using (bucket_id in (select id from storage.buckets where public));
  end if;
end $$;

-- ── Migration bookkeeping (same table the Supabase CLI uses) ─────────────
create schema if not exists supabase_migrations;

create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  name text,
  statements text[],
  applied_at timestamptz default now()
);

create table if not exists supabase_migrations.seed_files (
  path text primary key,
  hash text,
  applied_at timestamptz default now()
);

-- ── Realtime CDC plumbing ─────────────────────────────────────────────────
create schema if not exists tinbase;

create or replace function tinbase.cdc_notify() returns trigger
language plpgsql security definer as $$
declare
  payload text;
begin
  payload := json_build_object(
    'schema', TG_TABLE_SCHEMA,
    'table', TG_TABLE_NAME,
    'type', TG_OP,
    'commit_timestamp', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'record', case when TG_OP in ('INSERT', 'UPDATE') then row_to_json(NEW) else null end,
    'old_record', case when TG_OP in ('UPDATE', 'DELETE') then row_to_json(OLD) else null end
  )::text;
  -- pg_notify payloads are capped at ~8kB; degrade like Supabase does.
  if octet_length(payload) > 7500 then
    payload := json_build_object(
      'schema', TG_TABLE_SCHEMA,
      'table', TG_TABLE_NAME,
      'type', TG_OP,
      'commit_timestamp', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'record', null,
      'old_record', null,
      'errors', json_build_array('Payload too large')
    )::text;
  end if;
  perform pg_notify('tinbase_cdc', payload);
  return coalesce(NEW, OLD);
end $$;
`
