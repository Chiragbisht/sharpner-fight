-- ---------------------------------------------------------------- rooms

create table public.rooms (
  code        text primary key,
  host        uuid not null references auth.users(id) on delete cascade,
  guest       uuid references auth.users(id) on delete set null,
  host_ready  boolean not null default false,
  guest_ready boolean not null default false,
  state       jsonb,                      -- board state, straight from the sim
  score       jsonb not null default '[0, 0]'::jsonb,
  round       int not null default 1,
  turn        smallint not null default 0, -- 0 = host, 1 = guest
  seed        bigint not null,
  status      text not null default 'waiting',  -- waiting | lobby | playing | finished
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint rooms_status_valid check (status in ('waiting', 'lobby', 'playing', 'finished'))
);

alter table public.rooms enable row level security;

-- Only the two players can ever see a room. Note there is deliberately no
-- "anyone can read rooms that are waiting" policy: that would let a client list
-- every open room and join strangers' games. Joining goes through join_room()
-- below, which requires already knowing the code.
create policy "players can read their own room"
  on public.rooms for select
  to authenticated
  using ((select auth.uid()) in (host, guest));

create policy "players can update their own room"
  on public.rooms for update
  to authenticated
  using ((select auth.uid()) in (host, guest))
  with check ((select auth.uid()) in (host, guest));

grant select, update on public.rooms to authenticated;

-- Create a room with a unique, unambiguous code (no O/0 or I/1 confusion).
create function public.create_room()
  returns text
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  uid uuid := (select auth.uid());
  new_code text;
begin
  if uid is null then
    raise exception 'not signed in';
  end if;

  for _attempt in 1..10 loop
    new_code := '';
    for _i in 1..5 loop
      new_code := new_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;

    begin
      insert into public.rooms (code, host, seed)
      values (new_code, uid, floor(random() * 2147483647)::bigint);
      return new_code;
    exception when unique_violation then
      -- code taken, go round again
    end;
  end loop;

  raise exception 'could not allocate a room code';
end;
$$;

-- Join by code. This is a function rather than a policy so that knowing the
-- code is the only way in — there is no query that lists joinable rooms.
create function public.join_room(p_code text)
  returns public.rooms
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  r public.rooms;
begin
  if uid is null then
    raise exception 'not signed in';
  end if;

  update public.rooms
     set guest = uid, status = 'lobby', updated_at = now()
   where code = upper(p_code)
     and status = 'waiting'
     and guest is null
     and host <> uid
  returning * into r;

  -- One message for every failure: wrong code, room full, or your own room.
  -- Distinguishing them would turn this into a code oracle.
  if r.code is null then
    raise exception 'that room is not available';
  end if;

  return r;
end;
$$;

revoke execute on function public.create_room() from public, anon;
revoke execute on function public.join_room(text) from public, anon;
grant execute on function public.create_room() to authenticated;
grant execute on function public.join_room(text) to authenticated;

-- ---------------------------------------------------------------- matches

create table public.matches (
  id         uuid primary key default gen_random_uuid(),
  room_code  text,
  host       uuid references auth.users(id) on delete set null,
  guest      uuid references auth.users(id) on delete set null,
  winner     smallint,                    -- 0 = host, 1 = guest
  score      jsonb,
  played_at  timestamptz not null default now()
);

alter table public.matches enable row level security;

create policy "players can read their own matches"
  on public.matches for select
  to authenticated
  using ((select auth.uid()) in (host, guest));

create policy "players can record a match they played in"
  on public.matches for insert
  to authenticated
  with check ((select auth.uid()) in (host, guest));

grant select, insert on public.matches to authenticated;

create index matches_host_idx on public.matches (host, played_at desc);
create index matches_guest_idx on public.matches (guest, played_at desc);

-- ---------------------------------------------------------------- friendships

-- One row per friendship, in whichever direction it was asked. Storing a second
-- mirrored row would double every write and allow a half-friendship to exist.
create table public.friendships (
  requester  uuid not null references auth.users(id) on delete cascade,
  addressee  uuid not null references auth.users(id) on delete cascade,
  status     text not null default 'pending',  -- pending | accepted | blocked
  created_at timestamptz not null default now(),
  primary key (requester, addressee),
  constraint friendship_not_self check (requester <> addressee),
  constraint friendship_status_valid check (status in ('pending', 'accepted', 'blocked'))
);

alter table public.friendships enable row level security;

create index friendships_addressee_idx on public.friendships (addressee);

create policy "you can see friendships you are part of"
  on public.friendships for select
  to authenticated
  using ((select auth.uid()) in (requester, addressee));

create policy "you can send a friend request"
  on public.friendships for insert
  to authenticated
  with check ((select auth.uid()) = requester);

-- Only the person who received the request can accept or block it.
create policy "the addressee can answer a request"
  on public.friendships for update
  to authenticated
  using ((select auth.uid()) = addressee)
  with check ((select auth.uid()) = addressee);

create policy "either side can remove a friendship"
  on public.friendships for delete
  to authenticated
  using ((select auth.uid()) in (requester, addressee));

grant select, insert, update, delete on public.friendships to authenticated;
