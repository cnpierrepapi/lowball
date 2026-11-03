# How Lowball works

Plain-words notes on each feature: what the code does, what data moves where, what could
break it, and every bug hit while building it and how it was fixed.

It's a log, written in the order things were built, so a later section can change a number from an
earlier one. For example, the research thresholds went from 40 / 60 to 25 / 40, and the mission moved
to Solana. For the current picture in one place, see `ARCHITECTURE.md`.

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

## Drop emails with double opt-in

### What it does

Below the haggle there's a box: "I get new stuff in. Not often. Leave your email and I'll tell
you when." Leaving an address sends one email, "Confirm it's you", with a link. Only addresses
that click it ever get a drop email. Every drop email has a link to leave the list, and leaving
deletes the address.

### What data moves where

1. **Signup** (`POST /api/mail/signup`). The browser sends only the address, and only to our
   server. The server:
   - limits each IP to 5 signups a minute and 20 an hour;
   - trims and lowercases the address;
   - checks it has one `@`, a dotted domain, no spaces, and is 254 characters or fewer;
   - checks the domain can receive mail (a DNS lookup, 2 seconds at most; if DNS doesn't answer,
     the address is let through).

   Then it saves the row in the `subscribers` table: email, signup time, confirmed = no, and two
   random values called nonces (one for confirming, one for leaving). The answer to the browser
   is the same whatever happened, so nobody can use the box to find out who's on the list.
2. **The confirmation email.** It goes into the `outbox` table and is sent straight away if
   today's cap allows. Otherwise it goes out the next day.
3. **The links.** A link carries a token made from the row's nonce and the server's secret key
   (`OFFER_SIGNING_KEY`), labelled "confirm" or "unsub". The database holds the nonce and a hash
   of the token, never the token itself. So:
   - someone who reads the database can't make a working link;
   - a confirm link can't unsubscribe, and an unsubscribe link can't confirm;
   - one person's link only ever touches their own row;
   - a made-up token matches nothing.
4. **Confirming** (`/confirm` page, then `POST /api/mail/confirm`). Opening the link only shows a
   page with a "Yes, that's me" button. Pressing it confirms. This is because mail scanners open
   every link in an email to check it, and a link that worked on opening would sign people up
   without them. A confirm link works once, and for 7 days.
5. **Signing up again.**
   - Already confirmed: nothing happens.
   - Not confirmed, and the last link went out less than an hour ago: nothing happens.
   - Not confirmed, and the last link went out over an hour ago: a fresh link goes out, and the
     old link stops working.
6. **Leaving** (`/unsubscribe` page with a "Take me off" button, or the one-click unsubscribe
   that mail apps show). This deletes the row. Anything still queued for that address is
   deleted with it.
7. **A drop.** `announceDrop` queues one email per **confirmed** address, then starts sending.
   Announcing the same drop twice queues nothing new. The auctions feature will call this when a
   drop is scheduled. The email says when haggling opens, like "Thu 6 Nov, 18:00 UTC".
8. **Sending and the cap.** Everything Lowball sends goes through the outbox, so the cap covers
   all of it, confirmations included. Each round of sending:
   - takes a database lock, so two servers sending at once take turns;
   - counts what's gone out today (UTC) in `mail_days`;
   - takes at most `LOWBALL_MAIL_DAILY_CAP` minus that (default 40, at most 500, and a bad value
     falls back to 40), confirmations first;
   - sends a drop email only to a confirmed address, and a confirmation only to an unconfirmed
     one. This is checked again at the moment of sending.

   A failed send still counts against the cap. It's retried 10 minutes later at the earliest, and
   given up after 3 tries.
9. **The daily cron.** Once a day Vercel calls `/api/cron/mail` (in `vercel.json`), which sends
   whatever didn't fit under yesterday's cap. The route only answers a request carrying
   `Authorization: Bearer <CRON_SECRET>`. If `CRON_SECRET` isn't set, or is shorter than 16
   characters, it answers nobody.
10. **Live or not.** Only `MAIL_LIVE=1` (exactly that) sends through Zoho: port 465, a secure
    connection, the host from `ZOHO_SMTP_HOST` (default `smtp.zoho.eu`), and the address and
    password from `ZOHO_MAIL_USER` and `ZOHO_APP_PASSWORD`. The emails come from "Lowball".
    Without it, the log says who would have got which subject, with the address part-hidden and
    no links. Tests swap in a fake mailbox and never send anything.
11. **Links point at the right site.** The live site in production, the preview's own address on
    a preview, localhost in development. `LOWBALL_SITE_URL` overrides all of these if it's set.

### The database, and migrations

`db/002_mail.sql` adds `subscribers`, `outbox` and `mail_days`. `npm run build` now runs
`scripts/migrate.mts` before `next build`:
- On Vercel, `DATABASE_URL` is set, so any SQL file in `db/` that hasn't run yet runs in one
  transaction, together with a note in `schema_migrations` that it ran.
- A broken file changes nothing.
- Without `DATABASE_URL`, the step skips.
- Files only ever add things.

`/api/health` now reports:
- `database` (true, or "unreachable"; never the error text, which could carry connection
  details);
- `tables` (true when the four tables exist, which proves the migration ran);
- `mail` (fails only when `MAIL_LIVE=1` and the Zoho settings are missing);
- a true/false for each mail setting being present. It never shows a value.

### What could break it

- **The shared mailbox.** The Zoho mailbox is shared with another product, so a busy day there
  can use up Zoho's own limit. Lowball's sends then fail, get logged, and are retried later.
- **Spam folders.** Whether mail lands in the inbox depends on the domain's SPF and DKIM records
  in Zoho. The code can't check that.
- **Previews share the live database**, because `DATABASE_URL` is set for all environments. A
  test signup on a preview is a real row.
- **The cap under real concurrency.** The lock that makes two senders take turns can't be proven
  in the tests, which run one connection at a time (PGlite). The test with two senders at once
  passes, but it would pass without the lock too. On Neon, the lock is standard Postgres
  behaviour.
- **A slow DNS answer lets an address through.** At worst a confirmation goes nowhere and the row
  just stays unconfirmed.

### Tests

The SQL runs on real Postgres in memory (PGlite), with the same migration files as production.

- `lib/mail/mail.test.ts`:
  - addresses: good ones accepted and lowercased; 17 bad shapes and non-strings refused; the
    254-character limit; dead domains refused;
  - tokens: unique, labelled by purpose, need the server key, never stored;
  - double opt-in: one email, single use, 7 days, can't cross addresses or purposes, the hourly
    resend, nothing for confirmed addresses;
  - drops: confirmed addresses only, even when forced into the queue; once per drop; the
    unsubscribe link and header work; leaving clears the queue;
  - the cap: holds, the rest go the next day, confirmations count, zero means none, two senders
    at once, retries and giving up;
  - `MAIL_LIVE` must be exactly "1";
  - both emails word for word, and the date format.
- `lib/db.test.ts`: migrations run once, and a broken file leaves nothing half done. The games
  store's SQL on real Postgres: single-use start and finish, tied to the haggle.
- `app/api/mail/mail-routes.test.ts`, through the real routes:
  - signup saves, lowercases and sends;
  - bad addresses never reach the database;
  - the same answer for new, repeated and confirmed addresses;
  - the rate limit;
  - no database gives a 503;
  - confirm works once;
  - one-click unsubscribe from the header;
  - the cron turns away a missing, wrong, same-length-wrong or too-short secret.

As with games, each rule was deleted in turn to check a test fails (24 rules). The first pass
found four rules with no test that caught them; see the bugs below.

### Bugs hit while building it, and the fixes

1. **The tests took two minutes**, because each test started its own in-memory Postgres. Fix: one
   database per test file, with the tables wiped between tests. Now it takes 5 seconds.
2. **Four rules weren't really tested.**
   - An address confirmed while its confirmation email was still queued would still get that
     email. Fix: a new test.
   - The 254-character test address was also refused for a domain part over 63 characters, so
     the length rule itself was never tested. My first two attempts at a fix had the arithmetic
     wrong (254 instead of 255, then a 64-character part). Fix: an address of exactly 254 that
     passes, and 255 that fails, with every part valid.
   - The cron secret was only ever tried with wrong values of a different length, which the
     length check catches before the real comparison runs. Fix: a test with a wrong secret of
     the same length.
   - A too-short `CRON_SECRET` was never tried. Fix: a new test.
3. **A guard that wasn't a rule.** "Only send after a signup if something was queued" was just a
   shortcut, and no test could tell it apart from sending anyway. Fix: removed.
4. **Lockfile noise.** The npm here (version 10) stripped the `libc` fields from
   `package-lock.json`. Fix: installs are done with npm 11, so the lockfile diff is only the new
   packages.
5. **Stopping the dev server killed my own shell** halfway through writing these notes, so they
   had to be written twice. Nothing in the app was affected.
6. **The first preview build failed: "Cannot find module scripts/migrate.mts".** `.vercelignore`
   is an allowlist: Vercel only uploads the folders it names, so wallet keys and notes can never
   ride along. `scripts/`, `db/` and `vercel.json` weren't on it. So the migration script and its
   SQL never reached Vercel, and the daily cron in `vercel.json` would have been ignored as well.
   Fix: the allowlist now adds `db/`, `vercel.json` and `scripts/migrate.mts` only (the rest of
   `scripts/` stays local). To prove it, I copied only the files the allowlist lets through into
   an empty folder, then ran a clean `npm ci` and `npm run build` there. Both passed.

## Build packs, drops and auctions

### What it does

She doesn't sell an ebook any more. She sells **build packs**: the write-up of a tool that
developers keep asking for and nobody has built. Each pack is sold as a **drop**: a few copies
(5 by default), on sale between an opening time and a closing time. Once they're gone, they're
gone.

- **The free part (the teaser):** the problem, links to the real posts where developers asked for
  it, and what already exists. Anyone can read it on the pack's page.
- **The paid part:** the plan, a build prompt you paste into an AI coding tool, the tests that
  prove it works, and the risks.

### Who decides the numbers

The engine, from the pack, never the model (`lib/engine/drops.ts`):
- List price = 1.50 USDC + 1 cent per point of the pack's research score (0 to 100), so between
  1.50 and 2.50.
- Her secret floor = 55% of list.
- As copies go, the floor climbs evenly, until it's halfway between floor and list for the last
  copy. If the floor rises mid-haggle, her ask is lifted to it.
- Drops are cash only. Asking about friends just keeps her talking price.

### Selling the copies without overselling

When a buyer shakes hands, the server sets a copy aside for them (a **hold**) before it signs the
offer. A hold lasts 8 minutes: the 5 minutes the offer is good for, plus the 2 minutes a payment
can take to settle, plus a minute of slack. One SQL statement under a lock checks that held plus
sold copies are fewer than the total, so two buyers chasing the last copy can't both get it. The
loser hears "That one's gone. Someone beat you to it." and gets no offer, so no payment is ever
asked for a copy that doesn't exist.

When a hold's time is up, the server asks the chain whether that offer was paid (the receipt the
payment route already writes):
- paid: the copy is marked **sold**;
- not paid: it goes back on the shelf;
- the chain can't be asked: it stays taken, so nothing is ever oversold.

### What changed in the payment route (agreed on 3 Nov)

Packs live in the database, so the payment route looks items up with `itemById` instead of the
fixed list in the code: four lookups, nothing else. The price still comes only from the signed
offer.

### The old ebook

It's off the shelf: nobody can start a new haggle for it. Old receipts still open, and friends'
links for pledges that are still open still work.

### Pages

- `/`: what she does, the shelf of drops, the email box.
- `/pack/[id]`: the free part, the drop's state, the counter.
- `/notebook`: her research.
- `/admin`: the back office.
- `/read`: a bought pack in full.

The shopkeeper scene (three.js, about 560 KB) now loads after the words, on every page.

## The research loop and her notebook

### What it does

Every day she reads Hacker News and GitHub for developers saying things like "wish there was",
"is there a tool", "someone should build", "would pay for" and "why is there no". She groups
posts about the same missing tool into **leads** and scores them for free. Only when a lead passes
her checks does she spend money: first to look into it with web search, then to write the pack.
Then she puts the pack on the shelf and schedules its drop, and the drop email goes to confirmed
subscribers.

### Step by step (`lib/research/`)

1. **Watch (free).** Five short phrases are searched on each source over the last 7 days. Both
   sources were tested live on 3 Nov. Each source is a small function over `fetch`, so tests feed
   it recorded answers. Posts are saved in `posts`.
2. **Group (free).** Posts from the last 14 days are grouped. A post joins a group when it shares
   at least 3 topic words, and a fifth of its words, with a post already in the group. A lead's id
   is its oldest post, so it stays the same between runs.
3. **Score (free).** Five parts, 0 to 20 each, 100 in all. The notebook shows each part with its
   inputs and its rule:
   - Velocity: 20 × min(1, posts in the last 48 hours ÷ 3).
   - Sources: 20 × (0.75 × min(1, (different people − 1) ÷ 3) + 0.25 if it's on both HN and
     GitHub).
   - Size: 20 × min(1, log10(1 + points and comments) ÷ 3).
   - Pain: 20 × min(1, different pain phrases ÷ 4).
   - Novelty: 20 × (1 − min(1, log10(1 + matching GitHub repos) ÷ 4)). The repo count is a free
     GitHub search, done for at most 4 promising leads a run. A lead that wasn't checked gets 10.

   Under 40 is IGNORE, 40 to 59 is WATCH, 60 and up is INVESTIGATE.
4. **Coordinator checks (free), before any money is spent:**
   - On mission: at least 2 developer words, and not a list of issues all on one project (that's
     a feature request, not a missing tool).
   - Not done before: the same lead, or one sharing half its words, wasn't investigated in the
     last 30 days. A lead that was already worked on is never investigated again.
   - Under budget: what's been spent this month, plus the most the next step can cost ($0.60 to
     investigate, $0.50 to write), must stay under the monthly cap ($5 by default, set on the
     dashboard).
5. **Investigate (paid).** Claude Opus 5.5 with web search (`web_search_20260209`, at most 5
   searches) checks whether the tool exists, who tried, and how big the need is. A long search
   that pauses is carried on, at most 3 times. The notes are then put into a fixed shape that is
   checked against a schema. The real cost is recorded from the reply's usage figures: $4 per
   million input tokens, $20 per million output tokens, and $10 per 1,000 searches.
   - If the tool already exists, or the verdict is skip, the lead is closed and no pack is written.
   - If the model declines, the lead is marked failed.
   - A timeout or network error leaves the lead as it was, to try again.
6. **Write (paid).** Opus writes the pack's fields. The server then puts the pack together:
   - the links to the real posts come from our own data, never from the model;
   - any other link the model writes is removed, unless it came from the web search;
   - the build prompt sits in a code block it can't break out of;
   - the pack id is a lowercase slug of 32 characters or fewer, because the onchain receipt
     holds 32 bytes.
7. **On the shelf.** The pack gets its fingerprint (sha256), and the drop is scheduled. It opens at
   18:00 UTC, at least 12 hours ahead, with 5 copies for 48 hours. The drop email goes out when
   the drop is scheduled. Automatic drops can be turned off on the dashboard.
8. **Onchain fingerprint.** `lib/research/onchain.ts` is where the pack's hash goes onchain. It
   does nothing until the Solana program gets a new instruction, which needs a program upgrade
   from a local machine. The notebook says "not onchain yet" until then.

**When it runs:** Vercel calls `/api/cron/research` once a day (watch, then at most one
investigation and one pack). The dashboard can run each step by hand, including "Investigate
anyway" for a WATCH lead. That runs every check except the score threshold, and is marked in the
notebook.

### The admin dashboard (`/admin`)

**Logging in:**
- There's no password in the code, because the repo is public.
- The first visit sets the password. Only a slow scrambled version (scrypt) is stored, in the
  database. A second set is refused by the database itself.
- Logins are limited to 5 a minute per IP, and a login lasts 12 hours, in an HttpOnly, Secure,
  same-site cookie.
- Posts from other sites are refused.

**What it does:**
- Schedule a drop: preview the email and how many confirmed addresses get it, then confirm.
- Cancel a drop that hasn't opened.
- List packs with their fingerprint.
- Mail: counts, sent today against the cap, a switch for real sending (refused if the Zoho
  settings are missing), and "send what's waiting".
- Research: what's been spent against the cap, the cap itself, the automatic-drop switch, and each
  research step.

### What could break it

- **Few INVESTIGATE leads.** On a real week of posts (3 Nov), nothing scored past 29. The same need
  shows up over weeks, so scores grow as posts collect over the 14 days. Until then, "Investigate
  anyway" on a WATCH lead is how the first pack gets made.
- **Rate limits.** GitHub allows 10 searches a minute without a key. A run makes up to 9 (5
  phrases plus 4 repo counts). If GitHub says no, it's reported and the rest carries on.
- **Time limits.** Research can take minutes. The research routes may run up to 5 minutes; if the
  Vercel plan cuts that short, the step fails and the lead stays as it was.
- **Previews share the live database.** Packs, drops and the admin password made on a preview are
  live too.
- **Not proven here.** The real model calls can't run in this session, which has no API key. They
  are tested with a fake model; the real ones only run on Vercel.

### Bugs hit while building it, and the fixes

1. **Hacker News returned nothing.** The date filter's `>` has to be encoded (`%3E`); sent bare,
   HN silently matched nothing. Long exact phrases also almost never match ("I wish there was a
   tool" had 37 hits ever). Fix: the filter is encoded, there's a test for it, and the phrases are
   short.
2. **Node's fetch ignored this session's proxy.** That only affected the live test here, not
   Vercel. Fix: the live test runs with `NODE_USE_ENV_PROXY=1`.
3. **Pain words glued unrelated posts together.** "Painful", "tedious" and "hours" were counted as
   topic words, so six posts about six different tools became one lead. Fix: pain words count
   toward the pain score only, never toward grouping. A test with six topics proves it.
4. **Two rules had no test that caught them.** "Never investigate a lead twice" was hidden behind
   the 30-day check, and nothing tested the 4-lookup limit. Fix: tests for both.
5. **The admin page wouldn't build.** It read the clock while the page was being pre-built, which
   this Next version refuses. Fix: the default opening time is filled in when a pack is picked.
6. **The friend-link page would have pulled database code into the browser,** through the item
   list. Fix: the old book's public details live in `lib/oldbook.ts`, which has no server code.
7. **Payment library imports broke the route tests.** `@x402/next` imports `next/server` in a way
   plain Node can't resolve. Fix: vitest processes that one package itself.

### Tests

- `lib/engine/drops.test.ts`: the price rule, the floor's climb, the drop phases, and cash only
  (3,000 random haggles, no friends deal ever).
- `lib/shop/shop.test.ts`, on real Postgres:
  - holds never exceed copies, and only while the drop is open;
  - unpaid holds come back, paid ones are sold, and if the chain is down nothing is released;
  - races for the last copy;
  - one drop per pack, and the onchain hook.
- `app/api/haggle/drops.test.ts`, through the real route:
  - not open yet, sold out, beaten to it;
  - two handshakes at once for the last copy;
  - the floor rises;
  - no friends deal;
  - the old book only through a friend's link.
- `lib/research/research.test.ts`:
  - the sources against recorded answers, including the encoding bug;
  - every score part's rule, and a real week of posts;
  - every coordinator check, link stripping and the code fence;
  - the cost maths;
  - the whole loop with a fake model: no spend when a check fails, skip when it exists, refusals
    and network errors, the pack and its drop and email, automatic drop off, and the daily run.
- `app/api/admin/admin.test.ts`:
  - the first-visit password, the scrambled storage, the slowdown;
  - the cookie gate, forged cookies and other sites' posts;
  - the 12-hour login;
  - preview and scheduling (emails to confirmed addresses only);
  - the settings limits;
  - the research cron's lock.

As before, each rule was deleted in turn to check a test fails. The one rule no test catches on
its own is the password's set-once guard in `lib/admin.ts`. The database's set-once write enforces
the same thing, and that write has its own test.

## More sources, and cross-checking (3 Nov, later)

### What changed

- **Six sources instead of two.** All are free, need no key, and use no model; the search runs on
  its own.

  | Source | How she reads it |
  |---|---|
  | Hacker News, GitHub issues | As before. |
  | Stack Overflow and Software Engineering | Stack Exchange API. |
  | Reddit | r/programming, webdev, devops, ExperiencedDevs, selfhosted and SideProject, through the search RSS. |
  | dev.to | "discuss" and "help" posts. |
  | Lobsters | Newest stories. |

  Bluesky (403) and Mastodon (search is empty without an account) were tested and left out.
- **The cross-check.** After grouping, the 5 best leads that could ever be investigated (on
  mission, and not one project's feature request) are looked up on the sites they haven't turned
  up on yet, using the lead's 3 key words. A post found this way joins the lead if it shares at
  least 3 of the lead's words. It stays attached in later runs (`leads.cross_ids`), and the
  notebook marks it "found by cross-check".
- **Validation before money.** A new coordinator check, "Seen in 2 places": no lead is
  investigated, not even by hand, unless its posts come from at least 2 different sites.
- **Scoring.**
  - Sources is now 20 × (0.6 × min(1, (different sites − 1) ÷ 2) + 0.4 × min(1, (different
    people − 1) ÷ 3)), so agreement between sites counts more than a crowd on one site.
  - Thresholds, set by the owner: under 25 is IGNORE, 25 to 39 is WATCH, 40 and up is
    INVESTIGATE.
- **Key words.** A lead's key words are ranked by how many of its posts use them, by whether they
  appear in titles, and by how rare they are across everything read that week.

### Staying inside the free limits

| Source | Limit | Calls per run |
|---|---|---|
| GitHub | 10 searches a minute | 5 phrases, 3 repo counts, 2 cross-checks |
| Reddit | Throttles hard | All five phrases in one query, plus 2 cross-checks |
| Stack Exchange | 300 calls a day per network address | 4 watch searches, plus at most 5 cross-checks |

When any of them says no, the run notes it in its errors and carries on.

### Live run (3 Nov, all six sources, no model)

- **Read:** 245 posts. 30 from HN, 211 from GitHub, 1 from Stack Overflow, 3 from Reddit, none
  from dev.to or Lobsters that week.
- **Grouped:** 235 leads.
- **Cross-checked:** 5 leads, which pulled in 3 posts from other sites.
- **Result:** one lead (production server addresses in release builds) is now confirmed on 2
  sites and scores 41, which is INVESTIGATE.
- **Throttled:** Reddit answered 429 twice during the cross-checks; the run carried on.

### Bugs hit, and the fixes

1. **Reddit's JSON answered 403 to servers.** Fix: its search RSS, which answers.
2. **Reddit then answered 429 (too many requests)** after a few calls. Fix: one combined query
   per run, a cross-check budget of 2, and a descriptive client name.
3. **Stack Exchange's exact-phrase search found nothing in a week.** Fix: its looser search,
   keeping only questions that really use a pain phrase. Its free allowance is per network
   address and shared, so calls are kept few.
4. **The cross-check searched for nonsense.** In single-post leads every word appears once, so
   the tie-break picked words alphabetically ("actual agent assess avoid"). Fix: rank words by
   use, titles and rarity. Live, the queries became words like "equation inline display toolbar".
5. **The cross-check was spent on leads that could never be investigated.** Most GitHub hits are
   one project's feature requests, which the coordinator always rejects. Fix: only leads that
   pass "on mission" get cross-checked. The live run then attached its first posts.
6. **One rule had no test that caught it** ("don't cross-check a site the lead was already seen
   on"). Fix: a test.

### Tests

New in `lib/research/research.test.ts`:
- parsing each new source, and the Reddit one-request rule;
- the "seen in 2 places" check, including that forcing can't skip it;
- a cross-check attaching a matching Stack Overflow question but not an unrelated one, the match
  staying attached on the next run, and counting toward the check;
- the GitHub and Reddit call budgets;
- no cross-checks for off-mission leads, or for sites already seen.

Each rule was deleted in turn to check a test fails.

## The move to Solana developer tools, the chain as a source, and four fixes (3 Nov, later)

### Why
The first paid investigation spent $0.32 and correctly skipped its lead. But that lead shouldn't
have reached the paid step:
- It was two task tickets by an AI agent account, in two repos owned by one person.
- Its "second site" was a Show HN that shared three words with it.
- Nobody in it said anything hurt (pain score 0).
- Its novelty was the placeholder 10, never actually checked.

At the same time the owner moved the mission to crypto: the buyers already hold USDC on Solana,
and the chain itself can be read.

### The four fixes
1. **Same owner is one project, and bots are dropped.** Issues from one GitHub account or
   organisation count as one project's to-do list, which is never investigated. Posts from bot
   or agent accounts (names ending in `[bot]`, `-bot` or `-ai`, and dependabot, renovate,
   github-actions) are dropped as they're read.
2. **A cross-check match must be someone asking.** On top of the 3 shared words, the post must be
   a question or use a pain phrase. "Show HN" and "Launch HN" never count.
3. **A new check, "Someone said it hurts".** At least one post must use a pain phrase. A chain
   number alone never counts.
4. **Novelty is checked for real before spending.** If a lead's repo count is still the
   placeholder, she does the free lookup first and rescores. If the score drops below the bar, she
   stops. If GitHub doesn't answer, she stops and leaves the lead as it was.

### The new sources (all tested live on 3 Nov)

| Source | What she reads |
|---|---|
| Solana Stack Exchange, and Stack Overflow's `solana` tag | Every recent question (it's a few a week). |
| The Solana forum | Its public Discourse search (very quiet: one post a month). |
| Hacker News and GitHub | The pain phrases, plus the word "solana". |
| Reddit | r/solana, r/solanadev and r/CryptoTechnology. Best effort: it refuses Vercel. |
| dev.to | The `solana` tag. |
| **The chain** | Solana mainnet, through a public RPC. |

Lobsters was dropped, because it carries no crypto.

**The chain, in practice:**
- Once a run, for 8 popular programs (Jupiter, Raydium AMM and CLMM, Orca, Meteora, Pump.fun,
  Marinade, Metaplex; every address checked to be a deployed program), she reads their last
  1,000 transactions and counts the failures by error.
- If the most common error is at least 10% of a program's transactions, that becomes a finding
  in plain words, for example "54% of recent Jupiter v6 transactions fail with slippage tolerance
  exceeded".
- The error's name comes from the program's own logs where it gives one; otherwise it's shown
  by number. The only name written into the code is Jupiter's 6001.
- Calls are spaced out. A "slow down" (429) gets 3 tries, after 1, 2 and 4 seconds. If the RPC
  still says no, she skips the chain that day and notes it.
- Chain findings never group with each other, and never count as pain or as people.

**The window is now 30 days** instead of 7, because these sources are quiet.

### The owner's call: "seen twice"
Live, nothing showed up on 2 different sites. So "seen twice" now passes with 2 sites **or** 2
different people on the same site. Chain findings aren't people.

### Grouping long posts
Two Stack Exchange questions about the same need (getting tokens out of a protocol whose
website has died) shared 4 key words but didn't group: they're long, and the old rule also needed
a fifth of all their words to overlap. A post now also joins a group when it shares 4 key words,
one of them in both titles.

### Live run (3 Nov, no model)
- **Read:** GitHub 9, Stack Exchange 12, forum 1, chain 5, Hacker News 0, Reddit 0 (throttled).
- **Leads:** 27.
- **Passing every check:** the "dead frontend" lead: two people on Solana Stack Exchange, both
  stuck getting tokens out after a protocol's website went away. It scores 28 (WATCH), so it can be
  investigated by hand.
- **Not passing:** the chain findings (Jupiter slippage at 54%, Pump.fun at 54%) score high, but
  nobody on another site complained about them in those words, so they stay unpaid. That's by
  design.
- **One of the two askers is named "SolBotRescue".** The name suggests it may be an automated
  "rescue" account. The bot filter doesn't catch it, so the notebook shows both askers and the
  owner can judge.

### Bugs hit, and the fixes
1. **Chain findings glued together.** Their shared wording ("transactions fail with") grouped 5
   programs into one lead. Fix: chain findings never group with each other.
2. **The cross-check searched with junk.** For chain leads, the program address and CamelCase
   error names ranked as "rare words". Fix: findings are written in plain words with the address
   left out, and words over 24 characters are ignored.
3. **Newer transactions failed to load.** The RPC answered "Transaction version (1) is not
   supported". Fix: the request now asks for version 1. RPC errors in an answer are raised, not
   swallowed (tested).
4. **Four new rules had no test that caught them** on the first deletion pass: the pain check, a
   Stack Exchange site mistaken for a GitHub owner, "someone asking" in the cross-check, and
   stopping when the real novelty count sinks the score. Fix: a test for each, then the pass again
   (all caught).

### Tests
`lib/research/research.test.ts` now covers:
- every new source reader (Stack Exchange, forum, dev.to);
- the bot filter, while reading and in the cross-check;
- the chain: counting, naming, the 10% bar, the 429 backoff and its limit, RPC errors, and
  findings that never group or count as pain;
- the Solana mission check, same owner, "someone said it hurts" and "someone asking";
- seen twice by 2 people or 2 sites;
- the long-post grouping rule, using the dead-frontend pair;
- the real novelty check before spending, both when it sinks the score and when GitHub doesn't
  answer.

Each rule was deleted in turn to check a test fails.

## Last pass before the end of the build (3 Nov)

### She gives ground faster, and a real offer always moves her
- **Why low offers froze her.** Haiku often reads a very low offer (0.40 against 2.00) as rude.
  When she's offended at her top price, the engine had nowhere to raise to, so it answered "hold"
  and didn't move at all.
- **Fixes in `lib/engine/negotiate.ts`:**
  - **A real offer always moves her at least 3 cents,** never past her floor. Rudeness still costs
    mood, and still raises the price when it can.
  - **She concedes 0.45 × (1 − stubbornness) of the gap each round,** up from 0.35, plus a little
    more in a good mood. For a pack (stubbornness 0.55) that's about 20%, the owner's call. Polite
    offers on the live pack now go 2.10, 1.90, 1.75, 1.63, 1.53.
- **Tests:**
  - the 20,000-haggle random test still finds no deal under the floor;
  - new tests cover the curve, the 3-cent minimum, and a rude lowball at top price still moving her.
  - The first version of the minimum-step test passed even without the rule, because rounding to
    the cent happened to give the same 3 cents. It was moved 4 cents above the floor, where the two
    answers differ.

### The honesty check tells money from counts in digits
- **The gap:** she once said "hand over 4 for the book" because 4 was an allowed friend count. Game
  scores made this more likely, since a score of 7 is an allowed number too.
- **The fix:** the allowed numbers are now kept in two lists, prices and counts. A number in digits
  only counts as a count when it sits next to what's being counted ("4 friends", "scored 7");
  anything else has to be an allowed price. Numbers said in words already worked this way.
- **A rule removed:** a separate "next to USDC or $ means money" rule turned out to change nothing.
  A bare number already has to be a price, and deleting the rule failed no test. So it was taken
  out.

### `/lab` is gone from the live site
It returns 404 in production builds. It still works when running locally, for the cover and
stills scripts (`scripts/portrait.mts`, `scripts/stills.mts`).

### Cleanup
- **Removed, because nothing used them:**
  - `numbersIn` (the honesty check has its own scan now);
  - the `ResearchStore` type;
  - the old `mailer()` (the dashboard's switch replaced it);
  - three page strings: "Sticker price, if she had stickers", "Your friends came through", and
    "Out of test USDC".
- **`scripts/haggle.mts`** walked in on the old book, which is off the shelf. It now takes a pack id
  and defaults to the live pack.
- **The other scripts still work.** `e2e`, `pay` and `probe402` sign offers for the old book
  directly, and the payment route still accepts it, so the devnet end-to-end script (cash,
  pledges, referrals, refund and top-up) is unchanged.
- **One old lint error** in `engine.test.ts` was fixed. Lint is clean.
- **Docs:** the README was rewritten to match the code as it stands, and `docs/ARCHITECTURE.md`
  was added.

## Clearing non-Solana leads (3 Nov, after the build)

**What it does.** The dashboard's "Clear non-Solana leads" button, after a confirm, deletes every
lead where none of the posts mentions a word from the mission's Solana and crypto list.

**What it keeps:**
- leads she has already spent money on, or worked on, so the spending trail stays whole;
- every Solana lead.

**Why the posts go too.** Each watch rebuilds leads from the posts saved in the last 30 days, so
deleting a lead alone would only last until the next run. The clear also deletes the posts that
only those leads use, but never a post that a remaining lead still uses.

**Tests:**
- non-Solana leads go;
- Solana leads and paid-for leads stay;
- the next watch doesn't bring them back;
- a shared post survives;
- the dashboard action needs the login.

Each rule was checked by deleting it.

**Bug found on the first live clear (3 Nov).** The clear deleted 224 leads and 197 posts, but some
non-Solana leads stayed, such as "Check that the Store build finds the data of the portable build",
scoring 78. The Solana word list included everyday programming words ("program", "token",
"transaction", "wallet", "rpc", "swap", "mint"), so any post using them counted as Solana. The same
list decides "on mission" before money is spent, so this mattered beyond the notebook.

**Fix:** a lead needs at least one word that only appears in Solana or crypto talk, such as solana,
anchor, spl, lamports, pda, devnet, a program's name, usdc or x402. The everyday words still count
toward "2 developer words", but never make a lead Solana on their own. Tests cover both the mission
check and the clear; putting "program" back on the list fails them.

## Pay with any crypto, through Aurora Intents (3 Nov)

**What it does.** After a cash handshake, under the usual "Pay" button there's a second one: "Pay
with any crypto (real money)". The buyer picks what they hold (USDC or ETH on Base, Arbitrum or
Ethereum; USDT on Ethereum or Tron; USDC or SOL on Solana; or BTC) and types their own address on
that chain, for a refund. The shop asks Aurora Intents for a one-time deposit address. The buyer
sends the amount Aurora names. Aurora swaps it and delivers exactly the shaken price in USDC on
Solana mainnet to the shop's address. When Aurora says it's done, the buyer gets the pack, the
same as an x402 payment.

**What data moves where:**
1. The browser asks `GET /api/intents` for the list of tokens. Without a key saved in the back
   office, the answer is "off" and the button never shows.
2. The browser sends `start` with the signed offer, the token, and the refund address. The
   server checks the offer's signature and expiry, that it's a cash deal, and that it hasn't
   been paid onchain already. **The price comes only from the signed offer**, never from the
   browser.
3. For a pack, the copy's hold is stretched to 30 minutes (Aurora's 20-minute deadline plus 10).
   If the hold is already gone, the buyer hears "sold out" and Aurora is never asked.
4. The server asks Aurora for an EXACT_OUTPUT quote: exactly the price in micro-USDC, as USDC on
   Solana, to the shop's address. Aurora answers with a deposit address and how much of the
   buyer's token to send. That's saved in the `intent_payments` table, one row per offer, so
   asking again returns the same address and never a second quote.
5. The browser asks `status` every 5 seconds. The server asks Aurora. On SUCCESS, the server
   checks Aurora's own record: the recipient is the shop, the token is USDC on Solana, and at
   least the price arrived. If any of that is wrong, it's marked FAILED.
6. On a real SUCCESS, the server writes the usual onchain receipt on devnet (the buyer named if
   they gave a Solana refund address, otherwise the shop), marks the copy sold, and hands the
   browser the claim to read the pack.
7. On REFUNDED or FAILED, the copy goes back on the shelf. Aurora returns the money to the
   refund address.

**The back office:** a box for the Aurora key (Aurora's docs say the key isn't secret; it's
stored in the settings table, never sent back to the page), a line saying whether the shop's
address has a USDC account on Solana mainnet, and the last 10 payments with their status.

**What could break it:**
- Aurora is down or slow. The buyer sees "Aurora isn't answering", and the x402 button still
  works.
- The shop's address has no USDC account on mainnet. The back office warns about this.
- The buyer sends too little, or too late. Aurora refunds them. The copy goes back on the shelf.
- The receipt can't be written (devnet RPC down). The payment stays SUCCESS without a receipt.
  The next status check tries again, and the copy isn't marked sold until it's written.
- This is real money on mainnet. There's no test network for Aurora.

**Tests:** 16 in `lib/intents/pay.test.ts`, 10 in `app/api/intents/intents.test.ts`, and 1 in
`app/api/admin/admin.test.ts`, against a fake Aurora built from the documented response shapes.
Each of these 25 rules was checked by deleting it and confirming a test fails:
- the quote asks EXACT_OUTPUT, for the exact price, to the shop;
- the short token list;
- one payment per offer;
- a drop copy's hold is stretched, and no live hold means "sold out" with no quote;
- SUCCESS is only paid when the recipient, token and amount all match;
- refunds and failures release the copy;
- the copy is only sold once the receipt is written;
- final payments aren't asked about again;
- the buyer is named only with a Solana address;
- the signed offer, cash only, already paid, refund address and listed token checks on the
  route;
- the claim is only given when paid;
- the button is hidden without a key;
- the admin key is trimmed and junk is refused.

**Not tested:** a real payment through Aurora (it needs real money and the key), and the
buyer's panel in a browser.

**Bugs hit, and the fixes:**
- **`connection()` in the GET route throws outside a real request.** The route test replaces it
  with a no-op, the same way the test stands in for any other request.
- **The test pack's id was too short.** Pack ids are checked in the database (3 to 32
  characters), so "p1" became "pk1".
