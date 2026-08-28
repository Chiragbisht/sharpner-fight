import { supabase } from './supabase.ts';
import type { FriendLists, InvitePayload, Profile } from './types.ts';

// Friends, online status, and invites.
//
// A friendship is one row in whichever direction it was asked, so "my friends"
// has to look at both columns. RLS already limits every row to the two people
// involved, which is why these queries can select without a user filter.

export async function searchProfiles(query: string, meId: string): Promise<Profile[]> {
  const q = query.trim().replace(/[%,]/g, '');
  if (q.length < 2) return [];
  const { data, error } = await supabase
    .from('profiles')
    .select('id, handle, display_name, avatar_url')
    .or(`handle.ilike.%${q}%,display_name.ilike.%${q}%`)
    .neq('id', meId)
    .limit(8)
    .returns<Profile[]>();
  return error ? [] : data;
}

export async function requestFriend(addresseeId: string, meId: string): Promise<void> {
  const { error } = await supabase
    .from('friendships')
    .insert({ requester: meId, addressee: addresseeId });
  if (error) throw error;
}

export async function acceptFriend(requesterId: string, meId: string): Promise<void> {
  const { error } = await supabase
    .from('friendships')
    .update({ status: 'accepted' })
    .eq('requester', requesterId)
    .eq('addressee', meId);
  if (error) throw error;
}

interface FriendshipRow {
  requester: string;
  addressee: string;
  status: 'pending' | 'accepted' | 'blocked';
}

/** { friends, incoming, outgoing } — each an array of profile rows. */
export async function loadFriends(meId: string): Promise<FriendLists> {
  const { data: rows, error } = await supabase
    .from('friendships')
    .select('requester, addressee, status')
    .returns<FriendshipRow[]>();
  if (error || !rows?.length) return { friends: [], incoming: [], outgoing: [] };

  const otherId = (r: FriendshipRow) => (r.requester === meId ? r.addressee : r.requester);
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, handle, display_name, avatar_url')
    .in('id', rows.map(otherId))
    .returns<Profile[]>();

  const byId = new Map((profiles ?? []).map((p) => [p.id, p]));
  const out: FriendLists = { friends: [], incoming: [], outgoing: [] };

  for (const r of rows) {
    const profile = byId.get(otherId(r));
    if (!profile) continue;
    if (r.status === 'accepted') out.friends.push(profile);
    else if (r.status === 'pending') {
      (r.addressee === meId ? out.incoming : out.outgoing).push(profile);
    }
  }
  return out;
}

/**
 * Presence: who is online right now. Nothing is written to the database, so
 * there are no stale "online" rows to clean up when a tab dies.
 */
export function trackPresence(
  meId: string,
  onChange: (online: Set<string>) => void
): () => void {
  const channel = supabase.channel('online', {
    config: { private: true, presence: { key: meId } },
  });

  channel
    .on('presence', { event: 'sync' }, () => {
      onChange(new Set(Object.keys(channel.presenceState())));
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') await channel.track({ at: Date.now() });
    });

  return () => {
    void supabase.removeChannel(channel);
  };
}

/**
 * Invites ride a per-user channel.
 *
 * KNOWN LIMITATION: without Realtime Authorization policies configured, any
 * signed-in user could subscribe to someone else's user:<uuid> channel and read
 * their invites — which leaks room codes. The payload is only a room code, and
 * a code is useless once the room has a guest, but this should be locked down
 * with Realtime Authorization before the game is public. See README §3.
 */
export function listenForInvites(
  meId: string,
  onInvite: (payload: InvitePayload) => void
): () => void {
  const channel = supabase.channel(`user:${meId}`, { config: { private: true } });
  channel
    .on('broadcast', { event: 'invite' }, ({ payload }) => onInvite(payload as InvitePayload))
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}

export async function sendInvite(
  toUserId: string,
  payload: InvitePayload
): Promise<void> {
  // The insert policy admits an accepted friend, and joining needs read *or*
  // write — so this connects to send without ever reading their other invites.
  const channel = supabase.channel(`user:${toUserId}`, { config: { private: true } });
  await new Promise<void>((resolve) => {
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') resolve();
    });
  });
  await channel.send({ type: 'broadcast', event: 'invite', payload });
  await supabase.removeChannel(channel);
}
