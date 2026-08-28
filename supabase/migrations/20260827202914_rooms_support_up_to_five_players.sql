-- Rooms were built around exactly two people: a host column and a guest column.
-- Three to five players need seats, so the pair becomes an ordered array and the
-- seat index becomes the player number the sim already uses.
--
-- `host` is kept because matches references it and it is a cheap way to say who
-- runs the clock; `guest` stays nullable for the same reason but is no longer
-- how membership is decided.

alter table public.rooms
  add column players smallint not null default 2,
  add column seats   uuid[]   not null default '{}'::uuid[],
  add column ready   boolean[] not null default '{}'::boolean[],
  add constraint rooms_players_range check (players between 2 and 5);

update public.rooms
   set seats = array_remove(array[host, guest], null),
       ready = array_fill(false, array[coalesce(array_length(array_remove(array[host, guest], null), 1), 0)]);

-- Membership is now "your id appears in seats".
drop policy "players can read their own room" on public.rooms;
drop policy "players can update their own room" on public.rooms;

create policy "players can read their own room"
  on public.rooms for select
  to authenticated
  using ((select auth.uid()) = any (seats));

create policy "players can update their own room"
  on public.rooms for update
  to authenticated
  using ((select auth.uid()) = any (seats))
  with check ((select auth.uid()) = any (seats));

drop function if exists public.create_room();

create function public.create_room(p_players smallint default 2)
  returns text
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  uid uuid := (select auth.uid());
  n smallint := greatest(2, least(5, coalesce(p_players, 2)));
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
      insert into public.rooms (code, host, seed, players, seats, ready)
      values (new_code, uid, floor(random() * 2147483647)::bigint, n,
              array[uid], array[false]);
      return new_code;
    exception when unique_violation then
      -- code taken, go round again
    end;
  end loop;

  raise exception 'could not allocate a room code';
end;
$$;

create or replace function public.join_room(p_code text)
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

  -- Duplicate ids are deliberately allowed: joining your own room from a second
  -- tab is how this gets tested without a second Google account.
  update public.rooms
     set seats = seats || uid,
         ready = ready || false,
         guest = coalesce(guest, uid),
         status = case
                    when coalesce(array_length(seats, 1), 0) + 1 >= players then 'lobby'
                    else 'waiting'
                  end,
         updated_at = now()
   where code = upper(p_code)
     and status = 'waiting'
     and coalesce(array_length(seats, 1), 0) < players
  returning * into r;

  -- One message for every failure: wrong code or room already full.
  if r.code is null then
    raise exception 'that room is not available';
  end if;

  return r;
end;
$$;

-- Marking yourself ready touches one slot of an array, which PostgREST cannot
-- express, and it must be your own slot.
create function public.set_ready(p_code text, p_seat int)
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

  select * into r from public.rooms where code = upper(p_code);
  if r.code is null then
    raise exception 'no such room';
  end if;
  if p_seat < 0 or p_seat >= coalesce(array_length(r.seats, 1), 0) then
    raise exception 'no such seat';
  end if;
  if r.seats[p_seat + 1] <> uid then
    raise exception 'that is not your seat';
  end if;

  update public.rooms
     set ready = ready[1:p_seat] || array[true] || ready[p_seat + 2:],
         updated_at = now()
   where code = r.code
  returning * into r;

  return r;
end;
$$;

revoke execute on function public.create_room(smallint) from public, anon;
revoke execute on function public.join_room(text) from public, anon;
revoke execute on function public.set_ready(text, int) from public, anon;
grant execute on function public.create_room(smallint) to authenticated;
grant execute on function public.join_room(text) to authenticated;
grant execute on function public.set_ready(text, int) to authenticated;
