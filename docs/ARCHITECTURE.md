# Architecture

How Lowball is put together: the parts, how data moves between them, and where each rule lives.
For each feature in plain words, with what could break it and the bugs hit, see
`HOW_IT_WORKS.md`.

## The parts

| Part | Where | What it does |
|---|---|---|
| Web app | Next.js 16 (App Router, Cache Components) on Vercel | Pages and API routes. The only thing that talks to the database, the model, the chain and the mailbox. |
| Engine | `lib/engine/` | Plain TypeScript, no model. Every number: price, floor, concessions, games, drops. |
| Shopkeeper | `lib/shopkeeper.ts` | Claude Haiku 5.5 labels the buyer's message and says her line. The honesty and safety checks. |
| Games | `lib/games/` | Snake and Stack. The same code runs in the browser (to draw) and on the server (to replay and score). |
| Shop | `lib/shop/`, `lib/catalog.ts` | Packs, drops, and copies held at the handshake. |
| Research | `lib/research/` | Reading the sources, scoring, the coordinator's checks, and the two paid model calls. |
| Mail | `lib/mail/` | Double opt-in signups, one outbox under a daily cap, Zoho SMTP. |
| Payments | `lib/x402.ts`, `app/api/item/[id]` | x402 on Solana devnet: the price comes only from a signed offer. |
| Chain | `lib/chain.ts`, `anchor/programs/lowball` | Receipts for cash deals, and vaults for friends deals. |
| Database | Postgres on Neon, `db/*.sql` | Games, subscribers and outbox, packs, drops and holds, research notes, settings. |

## Pages

| Page | What it is |
|---|---|
| `/` | The shelf: what she does, the drops, the email box. |
| `/pack/[id]` | One pack: the free part, the drop's state, the counter to haggle at. |
| `/notebook` | Her research, in the open. |
| `/admin` | The back office: drops, packs, email, research. Password set on the first visit. |
| `/read?claim=` | A bought pack, for whoever holds the claim. |
| `/confirm`, `/unsubscribe` | Behind a button, so mail scanners opening links do nothing. |
| `/r/[nonce]` | A friend's referral link (pledges on the old book). |

`/lab` is a local bench for the shopkeeper scene, used by `scripts/portrait.mts` and
`scripts/stills.mts`. It's a 404 in production builds.

## API routes

| Route | Does |
|---|---|
| `POST /api/haggle` | One turn: label the message, step the engine, maybe offer a game, hold a copy at a handshake, say her line, sign the offer. |
| `POST /api/game` | `start` (reveals the seed, starts the clock) and `finish` (replays the moves, scores, moves the price). |
| `GET /api/item/[id]` | x402 payment for a signed offer, then the onchain receipt. |
| `GET`, `POST /api/intents` | Paying a signed cash offer with any crypto through Aurora Intents (real money, mainnet): the token list, `start` (a deposit address for the exact price), `status`. |
| `/api/pledge/[nonce]`, `/topup` | Friends deals: status, refund, top-up. |
| `/api/claim`, `/api/read`, `/api/preview/[id]` | Getting back to a purchase, reading it, and the free part. |
| `/api/mail/signup`, `confirm`, `unsubscribe` | Drop emails. |
| `/api/admin` | Everything the back office does. Needs the admin cookie, except logging in. |
| `/api/cron/mail`, `/api/cron/research` | The two daily jobs (in `vercel.json`), locked with `CRON_SECRET`. |
| `/api/health` | Every setting and connection, as true or false, never a value. |
| `/api/drip`, `/api/balance` | Test USDC for demo wallets. |

## How data moves

### A haggle turn
1. The browser sends the message and its sealed session. The session is signed by the server, so
   the browser can carry it but can't change it.
2. The server finds the item. For a pack, it also reads the drop's state, settles any holds whose
   time ran out (asking the chain whether they were paid), and works out today's floor.
3. Haiku labels the message: offer, accept, chat, walk; tone; amount. That label is checked again
   in code.
4. The engine steps: a counter, a raise, a deal, and so on. It may turn a counter into "entertain
   me" with a game.
5. **A deal on a pack first sets a copy aside** (a hold, 8 minutes) in one locked SQL statement. No
   copy, no deal.
6. Haiku says the line. It goes through the honesty check (only allowed numbers, money kept apart
   from counts) and the safety check (no copying the buyer, no links). Otherwise the built-in line
   is used.
7. The server signs the offer: item, price, expiry, a nonce shared with the hold.

### Paying
1. The browser calls `/api/item/[id]?offer=…`.
2. The route checks the offer's signature and expiry, and that it hasn't already been paid
   onchain.
3. The x402 facilitator settles the USDC transfer.
4. The route writes the receipt onchain. Later, the hold sees that receipt and the copy counts as
   sold.

### Paying with any crypto (Aurora Intents)
1. The browser sends the signed offer, a token and a refund address to `/api/intents`.
2. The server checks the offer like the x402 route does, stretches a pack's hold to 30 minutes,
   and asks Aurora for exactly the price in USDC on Solana mainnet, to the shop. The deposit
   address is saved in `intent_payments`, one per offer.
3. The browser asks for the status every 5 seconds; the server asks Aurora.
4. On SUCCESS, the server checks Aurora's record (recipient, token, amount), writes the usual
   devnet receipt, and marks the copy sold. On a refund or failure, the copy goes back.

### A game
1. **Offer:** the engine decides when. A row in `games` keeps the seed secret.
2. **Start:** single use. The database's clock starts, and the seed goes to the browser.
3. **Finish:** single use. The browser sends its moves. The server replays them from the seed,
   checks they took real time, scores them, and the engine moves the price, never below the floor.

### Research
1. **Watch (free).** It reads the sources: `lib/research/sources.ts`, and `chain.ts` for the RPC.
   Posts go into `posts`. It groups them into leads (`score.ts`), cross-checks the best leads on
   other sites, and scores everything into `leads`.
2. **Investigate (paid).** It runs the coordinator's checks (`coordinator.ts`), then the real
   novelty count, then Opus with web search (`model.ts`). The cost from usage goes into
   `research_spend`.
3. **Write (paid).** Opus writes the fields; `pack.ts` assembles the pack, with links from our own
   data only. It becomes a row in `packs` with its hash, its drop is scheduled, and the drop email
   goes out.

### Email
1. **Signup:** the address is checked, then a row in `subscribers` and a confirmation in `outbox`.
2. **Sending:** `drain` takes waiting emails under the daily cap (counted in `mail_days`, behind a
   lock) and sends them through Zoho. Without `MAIL_LIVE=1`, it only logs them.
3. **Links:** an HMAC of a stored nonce. The database never holds a working link.

## Where each rule lives

| Rule | File |
|---|---|
| Never below the floor in cash | `lib/engine/negotiate.ts`, fuzzed with 20,000 haggles in `engine.test.ts` |
| A real offer always moves her (3-cent minimum, about 20% of the gap for a pack) | `lib/engine/negotiate.ts` |
| Pack prices: 1.50 + 1 cent a point; floor 55%; rises to halfway by the last copy | `lib/engine/drops.ts` |
| Game offers and score value | `lib/engine/games.ts` |
| Only allowed numbers, money apart from counts | `lib/shopkeeper.ts` (`lineIsHonest`) |
| No overselling a drop | `lib/shop/store.ts` (`hold`) |
| Game anti-cheat | `lib/games/replay.ts`, `lib/games/store.ts` |
| No money spent on an unvalidated lead | `lib/research/coordinator.ts`, `loop.ts` (`investigate`) |
| Daily email cap, double opt-in | `lib/mail/store.ts` |
| Admin lock | `lib/admin.ts` |
| Clearing non-Solana leads keeps paid-for leads and shared posts | `lib/research/store.ts` (`clearOffMission`) |
| Any-crypto payments: price from the signed offer, paid only when Aurora's record matches | `app/api/intents/route.ts`, `lib/intents/pay.ts` |

## Deployment

- **Vercel builds** `npm run build`, which runs `scripts/migrate.mts` first. Migrations only ever add
  things, so rolling back the code is always safe.
- **`.vercelignore` is an allowlist.** Only the app's folders, plus `db/`, `vercel.json` and
  `scripts/migrate.mts`, are uploaded. Keys and local tools never leave the machine.
- **Two daily jobs:** mail at 09:17 UTC, research at 06:41 UTC.
- **Releases** are merge commits from `phase2` into `main`. See `RELEASES.md` for rolling back.

## Testing

- **`npm test`:** over 280 tests, no keys and no network.
  - The database code runs on real Postgres in memory (PGlite), with the same migration files as
    production.
  - Routes are tested by calling the real route handlers.
  - The model and the outside sites are fakes, built from saved real answers where possible
    (`lib/research/fixtures/`).
- **Rule checks:** every rule added in phase 2 was checked by deleting it and confirming a test
  fails.
- **`npm run test:live`:** the shopkeeper against the real model. It needs `ANTHROPIC_API_KEY`.
- **`anchor test`:** the Solana program.
