-- Public mirror of auth.users: handle, display name, avatar.
-- auth.users itself is never exposed to the client.
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  handle       text not null unique,
  display_name text,
  avatar_url   text,
  created_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Any signed-in user can read profiles: friend search (step 8) needs it, and a
-- profile holds nothing private. Anonymous visitors get nothing.
create policy "profiles are readable by signed-in users"
  on public.profiles for select
  to authenticated
  using (true);

-- You may only ever write your own row. WITH CHECK on the update is what stops
-- someone reassigning a row to a different id.
create policy "you can insert your own profile"
  on public.profiles for insert
  to authenticated
  with check ((select auth.uid()) = id);

create policy "you can update your own profile"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

grant select, insert, update on public.profiles to authenticated;

-- Create the profile row the moment a Google sign-in creates the user.
-- SECURITY DEFINER is required: the insert happens in the auth schema's context,
-- which has no rights on public.profiles.
--
-- raw_user_meta_data is user-editable, so it is only ever used here for display
-- text — never for anything that decides permissions.
create function public.handle_new_user()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, avatar_url, handle)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url',
    'player_' || substr(replace(new.id::text, '-', ''), 1, 8)
  );
  return new;
end;
$$;

-- Postgres grants EXECUTE to PUBLIC on every new function, which would make this
-- SECURITY DEFINER function callable by anon and authenticated. Take that back —
-- only the trigger should ever run it.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
