-- Hiring Flow dashboard tables. Touches no existing table.
create table if not exists public.hf_members (
  email text primary key,
  added_at timestamptz not null default now()
);

create or replace function public.hf_is_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.hf_members
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function public.hf_is_member() from public;
grant execute on function public.hf_is_member() to authenticated;
revoke execute on function public.hf_is_member() from anon;

-- One row per role (job) being hired for.
create table if not exists public.hf_roles (
  id text primary key,
  doc jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
-- One row per candidate per role. doc.jay holds Jay's decisions from the dashboard.
create table if not exists public.hf_candidates (
  id text primary key,
  role_id text not null references public.hf_roles(id) on delete cascade,
  doc jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists hf_candidates_role on public.hf_candidates(role_id);
-- One row per job post (LinkedIn, Indeed, ...).
create table if not exists public.hf_postings (
  id text primary key,
  role_id text not null references public.hf_roles(id) on delete cascade,
  doc jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
-- Activity log: runs, sends, decisions.
create table if not exists public.hf_events (
  id bigint generated always as identity primary key,
  role_id text references public.hf_roles(id) on delete cascade,
  at timestamptz not null default now(),
  doc jsonb not null default '{}'::jsonb
);
create index if not exists hf_events_role_at on public.hf_events(role_id, at desc);

create or replace function public.hf_touch() returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end; $$;
do $$ declare t text; begin
  foreach t in array array['hf_roles','hf_candidates','hf_postings'] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I for each row execute function public.hf_touch()', t, t);
  end loop;
end $$;

alter table public.hf_members    enable row level security;
alter table public.hf_roles      enable row level security;
alter table public.hf_candidates enable row level security;
alter table public.hf_postings   enable row level security;
alter table public.hf_events     enable row level security;

drop policy if exists "hf members read" on public.hf_members;
create policy "hf members read" on public.hf_members for select to authenticated using (public.hf_is_member());
do $$ declare t text; begin
  foreach t in array array['hf_roles','hf_candidates','hf_postings','hf_events'] loop
    execute format('drop policy if exists "hf members only" on public.%I', t);
    execute format('create policy "hf members only" on public.%I for all to authenticated using (public.hf_is_member()) with check (public.hf_is_member())', t);
  end loop;
end $$;

insert into public.hf_members (email) values ('jay@utopiancapitalinvest.com'), ('jayrav70@gmail.com')
on conflict do nothing;

do $$ begin
  begin alter publication supabase_realtime add table public.hf_candidates; exception when others then null; end;
  begin alter publication supabase_realtime add table public.hf_postings;   exception when others then null; end;
  begin alter publication supabase_realtime add table public.hf_events;     exception when others then null; end;
  begin alter publication supabase_realtime add table public.hf_roles;      exception when others then null; end;
end $$;
