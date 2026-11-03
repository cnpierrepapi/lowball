-- Paying with any crypto through Aurora Intents. One row per signed offer paid this way. The
-- buyer sends their own token to a one-time deposit address; Aurora delivers the exact price in
-- USDC to the shop's Solana address. The row tracks it until it's final.
CREATE TABLE IF NOT EXISTS intent_payments (
  nonce            text PRIMARY KEY,             -- the signed offer's nonce (and the hold's)
  item             text NOT NULL,
  price            bigint NOT NULL,              -- micro-USDC, from the signed offer
  origin_asset     text NOT NULL,                -- what the buyer pays with (Aurora asset id)
  refund_to        text NOT NULL,                -- where Aurora refunds them, on the origin chain
  deposit_address  text NOT NULL UNIQUE,
  deposit_memo     text,
  amount_in        text NOT NULL,                -- what to send, in the origin token's smallest unit
  amount_in_text   text NOT NULL,                -- the same, readable
  deadline         timestamptz NOT NULL,
  status           text NOT NULL,                -- Aurora's status: PENDING_DEPOSIT ... SUCCESS / REFUNDED / FAILED
  amount_out       text,                         -- USDC that actually arrived (smallest unit)
  receipt_written  boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL
);
