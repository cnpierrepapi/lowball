import type { State } from "./engine/negotiate";
import type { GameKind } from "./games/replay";
import type { Turn } from "./shopkeeper";

// One haggle, sealed by the server and carried by the browser between requests.
export interface Session {
  id?: string; // haggles from before games existed have none, and never get a game
  item: string;
  state: State;
  history: Turn[];
  exp: number;
  ref?: string; // came in through a pledger's link
  turns?: number; // every message counts, chat included
  game?: { id: string; kind: GameKind }; // the game she just asked for, until the next message
}
