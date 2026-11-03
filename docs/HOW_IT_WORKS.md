# How Lowball works

Plain-words notes on each feature: what the code does, what data moves where, what could
break it, and every bug hit while building it and how it was fixed.

## Games: "Entertain me"

### What it does

Sometimes in the middle of a haggle she gets bored and asks for a game: Snake or Stack. Play
well and her price comes down. Play badly and nothing changes. Her price never goes under her
floor, whatever the score.

- **Snake.** Steer with the arrow keys or by swiping. Eat the red dots and don't hit the walls
  or yourself. Score = dots eaten. At most about 60 seconds.
- **Stack.** A block slides back and forth. Tap, click or press space to drop it. Whatever hangs
  over the block below gets cut off. Miss completely and the game ends. Score = blocks stacked.
  At most 60 seconds.

### Who decides what

The engine decides everything. The model only says the line.

- **When she gets bored** (`lib/engine/games.ts`, `gameToOffer`). All of these must be true:
  - the haggle is still open;
  - she just countered or held (not right after a deal, a raise or a walk-out);
  - her mood is above -0.5, because angry shopkeepers don't play;
  - her ask is at least 5% of the list price above her floor, so there is something to win;
  - no game has come up in this haggle yet. One game per haggle.

  The round it happens on (3, 4 or 5) and which game it is both come from a hash of the haggle's
  id. So it feels random, but it's fixed per haggle and asking again can't reroll it.
- **What a score is worth** (`askAfterGame`):
  `new ask = ask - (score / target) x 50% x (ask - floor)`, rounded down to the cent, then held
  between the floor and the old ask. The target is 15 dots for Snake and 20 blocks for Stack.
  Scoring over the target counts as hitting the target. A score of zero changes nothing. A
  weird score (negative, not a number, infinite) is treated as zero.
- **What she says.** Her lines go through the same honesty guard as every other line. The score
  is added to the numbers she may say, and nothing else is. If the model's line fails the guard,
  she says the safe built-in line instead.

### What data moves where

1. **Offer.** The buyer sends a haggle message as normal. If the engine says she's bored, the
   server makes a game id, picks a random seed (128 random bits from the operating system),
   and saves both in the `games` table in Neon Postgres. The reply carries the game id and the
   game's name. **It doesn't carry the seed.** The haggle's sealed state remembers which game
   was offered.
2. **Start.** The buyer presses "Entertain her". The page calls `POST /api/game` with
   `op: "start"`. The server checks the game belongs to this haggle and hasn't been started,
   writes the start time using the database's clock, and only now sends the seed. Start works
   once, and only within 10 minutes of the offer.
3. **Play.** The browser runs the same game code as the server (`lib/games/snake.ts`,
   `lib/games/stack.ts`), from the same seed, so it sees the same game. It draws it and records
   what the player pressed and on which tick, like "turned left on tick 42". It never works out a
   score to send.
4. **Finish.** The browser sends `op: "finish"` with that list of presses and the tick it stopped
   on. The server:
   - checks the list (`readLog`): whole numbers only, ticks strictly going up, every press before
     the stop tick, real directions only, not too many presses, the stop tick inside the time
     limit;
   - replays the game from the seed it saved and counts the score itself (`replay`);
   - checks the game took at least as long on the server's clock as it claims to have lasted
     (`playedInRealTime`, with 1.5 seconds of slack for the browser's timer);
   - closes the game in the database so it can never be finished again.

   A bad log or a too-fast log also closes the game, with a score of 0, so a cheater gets one
   try, not many.
5. **Price.** The engine turns the score into her new ask. She says it. The new ask goes into the
   haggle's sealed state, and "deal" after that is a normal cash deal at the new price. The
   payment code is untouched: it signs and charges whatever the engine decided, as before.

### The database

`db/001_games.sql` makes one table, `games`. To set it up, open the Neon project's SQL editor and
paste the file in, or run it with `psql "$DATABASE_URL" -f db/001_games.sql`. The app reads
`DATABASE_URL` to find the database (`lib/db.ts`).

Every single-use rule is a single SQL statement, so two requests racing for one game can't both
win. For example, Start is "set started_at where it is still empty", and only one request can
do that.

`lib/games/store.ts` has two versions with the same shape: Postgres for real use, and an
in-memory one for tests and local development.

### What could break it, and what's left

- **No `DATABASE_URL` in production:** games are off. She never offers one, and the haggle works
  as before. Without the database there's no single-use rule, so no games.
- **Database down when she'd offer a game:** she just keeps haggling. The offer only goes out
  once the game is saved.
- **Bots:** any game in a browser can be played by a script that sends perfect moves in real time.
  What protects the shop is the cap on what a game can win: at most half the gap to her floor,
  never below the floor, and one game per haggle. A patient haggler can reach the floor anyway.
- **Copying someone else's great game:** the log only means something with its own seed. On
  another seed it plays out differently and usually crashes early (tested).
- **Practising on the seed first:** the seed only appears at Start, and the clock starts then.
- **Changing the game code:** the browser and the server must run the same version. A deploy in
  the middle of someone's game could make their replay disagree. That's rare and costs them one
  game.
- **Haggles started before this shipped** have no id, so they never get a game.

### Tests

- `lib/games/games.test.ts`:
  - The same seed and log always give the same score.
  - A score field the browser sends is ignored.
  - A log copied from another seed is worth little.
  - Every malformed log is refused.
  - Games that end in a crash or a miss replay cleanly.
  - The real-time rule holds.
  - Start and Finish are each single use, inside their time windows, and tied to their own haggle.
  - Too-fast and forged logs burn the game.
  - Two racing Finishes: only one wins.
- `lib/engine/games.test.ts`: every condition for getting bored, and the plan is fixed per haggle.
  The score maths:
  - zero changes nothing;
  - a perfect game takes half the gap;
  - beating the target earns no more;
  - a higher score never costs more;
  - 5,000 random asks and scores never go under the floor or over the ask.

  The safe built-in lines pass the honesty guard.
- `app/api/game/game.test.ts`: the whole loop through the real routes, with only the two model
  calls faked:
  - haggle until she's bored, start, play, finish, and the price drops;
  - "deal" then gives a cash deal at the new price;
  - finishing twice fails;
  - another haggle's game id is refused;
  - a tampered session is refused;
  - a too-fast log earns nothing;
  - talking walks away from the game;
  - only one game per haggle;
  - no database means no games;
  - a database failure means no game and no harm.

Each rule was checked by deleting it and confirming a test fails (26 rules, all caught).

### Bugs hit while building it, and the fixes

1. **Stack couldn't be lost.** The sliding block stayed inside the play area, which was never
   more than one block width away from the tower, so every drop landed. A test waiting for a
   miss looped forever. Fix: the block now slides half off either edge, so it can miss
   completely. The starting block is 40 wide instead of 60.
2. **The test for "too many presses" didn't test that rule.** The oversized log it used was also
   refused for having a press on the stop tick, so deleting the size limit didn't fail any test.
   Fix: a new test with 201 valid, well-spaced drops, which is refused only by the size limit.
3. **Start was called twice in development.** In development, React deliberately runs a
   component's start-up code twice. The game board called Start in its start-up code. The
   second call hit the single-use rule and the game closed straight away. Fix: Start is called
   once from the "Entertain her" button, and the board gets the seed as an input.
4. **A Stack game that ended on a miss was refused as a bad log.** A miss ended the game without
   moving the tick counter, so the final drop sat on the stop tick, and the log check refuses
   any press on or after the stop tick. Fix: a miss uses up its tick like any other drop. There's
   a test for this, and one for Snake ending in a crash.
5. **Local dev lost games between routes.** Without a database, dev uses a memory store. Dev
   reloads gave the haggle route and the game route separate copies of it, so Start couldn't
   find the game the haggle had just offered. Fix: the dev store sits on `globalThis` so every
   route shares it. Production uses Postgres and wasn't affected.
