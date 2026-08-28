import type { GameState } from '../game/types.ts';

// Row shapes as they come back from Supabase, plus the payloads that ride the
// Realtime channels. Hand-written rather than generated: the app touches a
// handful of columns, and a generated Database type would drag the whole schema
// into every import.

export interface Profile {
  id: string;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
}

/** What auth.ts returns — the same row minus `id`, which the caller supplied. */
export type OwnProfile = Omit<Profile, 'id'>;

export type RoomStatus = 'waiting' | 'lobby' | 'playing' | 'finished';

export interface Room {
  code: string;
  host: string;
  guest: string | null;
  players: number;
  /** Seat index *is* the player number the sim uses. */
  seats: string[];
  ready: boolean[];
  state: GameState | null;
  score: number[];
  round: number;
  turn: number;
  seed: number;
  status: RoomStatus;
  created_at: string;
  updated_at: string;
}

/** The columns the client is allowed to write back mid-match. */
export type RoomPatch = Partial<
  Pick<Room, 'state' | 'score' | 'round' | 'turn' | 'seed' | 'status'>
>;

export interface FriendLists {
  friends: Profile[];
  incoming: Profile[];
  outgoing: Profile[];
}

// --- Realtime payloads ----------------------------------------------------

/** Who is sitting where, and what sharpener they picked. Cosmetic + seating. */
export interface SeatPayload {
  seat: number;
  skin: string;
}

export interface StartPayload extends Partial<SeatPayload> {
  seed: number;
  turn: number;
  players: number;
}

export interface RematchPayload {
  seed: number;
  players: number;
}

export interface InvitePayload {
  code: string;
  from: string;
}
