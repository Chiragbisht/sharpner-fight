-- Drop the "you cannot join your own room" guard.
--
-- It was there to stop someone clicking their own share link and filling their
-- own guest seat. In practice it makes the game untestable without a second
-- Google account: two tabs on one account is the natural way to try online
-- play. Occupying both seats of your own room is harmless — you just end up
-- playing yourself — and a new room is one click away.
--
-- Everything that actually matters is unchanged: a room is still only visible
-- to its two players, and joining still requires knowing the code.
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

  update public.rooms
     set guest = uid, status = 'lobby', updated_at = now()
   where code = upper(p_code)
     and status = 'waiting'
     and guest is null
  returning * into r;

  -- One message for every failure: wrong code or room already full.
  -- Distinguishing them would turn this into a code oracle.
  if r.code is null then
    raise exception 'that room is not available';
  end if;

  return r;
end;
$$;

revoke execute on function public.join_room(text) from public, anon;
grant execute on function public.join_room(text) to authenticated;
