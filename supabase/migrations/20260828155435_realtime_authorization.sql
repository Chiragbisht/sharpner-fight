-- Realtime Authorization: lock down the broadcast and presence channels.
--
-- Until now every channel was public. A Supabase Realtime channel is guarded by
-- nothing but its name unless you (a) write RLS policies on realtime.messages
-- and (b) open the channel with `private: true`. Both room:<CODE> and
-- user:<UUID> were plain public channels, and neither name is a secret:
-- searchProfiles() hands any signed-in user the id of any other profile, which
-- is the whole of the user:<UUID> topic. So anyone with an account could
-- subscribe to a stranger's invite channel, read the room code out of it, and
-- take their seat with join_room() — or subscribe to room:<CODE> and broadcast
-- a forged flick into someone else's match.
--
-- Realtime runs these policies as the connecting user with their JWT, so
-- auth.uid() works here and RLS on the public tables applies to the subqueries.
--
-- NOTE: a private channel and a public channel with the same topic name are
-- distinct channels and never exchange messages, so `private: true` on every
-- client is what actually closes the hole. Disabling "Allow public access" in
-- Realtime Settings is the belt-and-braces step that stops a future code path
-- from silently opening a public channel again.

-- --------------------------------------------------------------- room:<CODE>
-- Your seat in the room is the credential. `seats` is the membership list, and
-- rooms' own RLS already limits a select to rooms you are seated in — the
-- explicit any(seats) check is here so the rule is readable on its own terms.

create policy "players read their own room channel"
  on realtime.messages for select
  to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and exists (
      select 1 from public.rooms
       where (select realtime.topic()) = 'room:' || code
         and (select auth.uid()) = any (seats)
    )
  );

create policy "players send on their own room channel"
  on realtime.messages for insert
  to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and exists (
      select 1 from public.rooms
       where (select realtime.topic()) = 'room:' || code
         and (select auth.uid()) = any (seats)
    )
  );

-- --------------------------------------------------------------- user:<UUID>
-- Read your own invite channel and nobody else's.

create policy "read own invite channel"
  on realtime.messages for select
  to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (select realtime.topic()) = 'user:' || (select auth.uid())::text
  );

-- Writing to someone else's invite channel is allowed only between accepted
-- friends, which is also the only path the UI offers. Joining a topic needs
-- read *or* write, so this insert policy is what lets sendInvite() connect —
-- without granting it read access to the recipient's other invites.
--
-- Comparing against the friendship row's own columns avoids parsing a uuid out
-- of the topic string, which would throw on a malformed topic.
create policy "invite an accepted friend"
  on realtime.messages for insert
  to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and exists (
      select 1 from public.friendships f
       where f.status = 'accepted'
         and (
           (f.requester = (select auth.uid())
             and (select realtime.topic()) = 'user:' || f.addressee::text)
           or
           (f.addressee = (select auth.uid())
             and (select realtime.topic()) = 'user:' || f.requester::text)
         )
    )
  );

-- ------------------------------------------------------------------- online
-- The presence roster. Any signed-in user may join and publish their own
-- presence: it carries nothing but "this id is connected", and the UI only
-- ever renders it for people already on your friends list.

create policy "signed-in users read the presence roster"
  on realtime.messages for select
  to authenticated
  using (
    realtime.messages.extension = 'presence'
    and (select realtime.topic()) = 'online'
  );

create policy "signed-in users publish their presence"
  on realtime.messages for insert
  to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and (select realtime.topic()) = 'online'
  );
