import { supabase } from './supabase.ts';
import type { Flick } from '../game/types.ts';
import type {
  RematchPayload,
  Room,
  RoomPatch,
  SeatPayload,
  StartPayload,
} from './types.ts';

// Online play. The room row is the durable record (so a refresh can resume);
// the Realtime channel carries the live turn-by-turn traffic.
//
// Only flick inputs go over the wire — { player, angle, power, seed } — never
// positions. Both clients run the same deterministic sim from that input and
// land on identical state. See README §2.

export async function createRoom(players = 2): Promise<string> {
  const { data, error } = await supabase.rpc('create_room', { p_players: players });
  if (error) throw error;
  return data as string;
}

/** Marking your own seat ready — an RPC because it edits one array slot. */
export async function setReady(code: string, seat: number): Promise<Room> {
  const { data, error } = await supabase.rpc('set_ready', { p_code: code, p_seat: seat });
  if (error) throw error;
  return data as Room;
}

export async function joinRoom(code: string): Promise<Room> {
  const { data, error } = await supabase.rpc('join_room', {
    p_code: code.trim().toUpperCase(),
  });
  if (error) throw error;
  return data as Room;
}

export async function fetchRoom(code: string): Promise<Room | null> {
  const { data, error } = await supabase
    .from('rooms')
    .select('*')
    .eq('code', code)
    .maybeSingle<Room>();
  if (error) throw error;
  return data;
}

export async function patchRoom(code: string, patch: RoomPatch): Promise<void> {
  const { error } = await supabase
    .from('rooms')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('code', code);
  if (error) throw error;
}

export async function recordMatch(
  room: Room,
  winner: number,
  score: number[]
): Promise<void> {
  const { error } = await supabase.from('matches').insert({
    room_code: room.code,
    host: room.host,
    guest: room.guest,
    winner,
    score,
  });
  if (error) throw error;
}

/** Payload for each broadcast event a room channel carries. */
export interface RoomEvents {
  flick: Flick;
  ready: SeatPayload;
  joined: SeatPayload;
  start: StartPayload;
  left: Record<string, never>;
  rematch: RematchPayload;
}

export type RoomHandlers = {
  [E in keyof RoomEvents]?: (payload: RoomEvents[E]) => void;
} & {
  status?: (status: string) => void;
};

export interface RoomChannel {
  send<E extends keyof RoomEvents>(event: E, payload?: RoomEvents[E]): void;
  leave(): void;
}

/**
 * Subscribe to a room's live channel. `self: false` keeps our own broadcasts
 * from echoing back — the flicking client has already run the shot locally.
 */
export function joinChannel(code: string, handlers: RoomHandlers = {}): RoomChannel {
  // private: true routes this through the realtime.messages RLS policies, so
  // only someone holding a seat in this room can join or send. Without it the
  // channel is public and its name is the only thing guarding it.
  const channel = supabase.channel(`room:${code}`, {
    config: { private: true, broadcast: { self: false } },
  });

  const events: (keyof RoomEvents)[] = [
    'flick', 'ready', 'joined', 'start', 'left', 'rematch',
  ];
  for (const event of events) {
    channel.on('broadcast', { event }, ({ payload }) => {
      // One erased call site: the map above pairs each name with its payload,
      // but TypeScript cannot see that `event` and `payload` move together
      // through Supabase's untyped broadcast signature.
      (handlers[event] as ((p: unknown) => void) | undefined)?.(payload);
    });
  }

  channel.subscribe((status) => handlers.status?.(status));

  return {
    send: (event, payload = {} as never) => {
      void channel.send({ type: 'broadcast', event, payload });
    },
    leave: () => {
      void supabase.removeChannel(channel);
    },
  };
}
