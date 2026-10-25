// Every word the shop page says, in one place.
import { formatUsdc } from "./engine/money";

const u = (micro: number) => formatUsdc(micro);

export const copy = {
  headline: "Nothing in this shop has a price tag.",
  sub: "Talk him down. Pay what you shake on, in USDC on Solana.",
  walkIn: "Walk in",
  placeholder: "Make him an offer",
  send: "Say it",
  hisPrice: "His price",
  yourDeal: "Your deal",
  listed: "Sticker price, if he had stickers",
  mood: "Mood",
  moods: ["Livid", "Fuming", "Grumpy", "Tolerating you", "Almost fond"],
  devnet: "Devnet. Test money only.",

  payCash: (p: number) => `Pay ${u(p)} USDC`,
  payPledge: (p: number, n: number) => `Pay ${u(p)} now, bring ${n} ${n === 1 ? "friend" : "friends"}`,
  paying: "Paying...",
  delivered: "It's yours.",
  readIt: "Read it",
  keepLink: "Bookmark this page. It gets you back to your copy.",
  receipt: "See the payment on Solana",

  pledged: (n: number) => `Paid. Now ${n} ${n === 1 ? "friend has" : "friends have"} to buy through your link.`,
  progress: (have: number, need: number) => `${have} of ${need} bought`,
  timeLeft: (s: number) =>
    s <= 0 ? "Time's up" : s < 3600 ? `${Math.ceil(s / 60)} min left` : s < 86400 ? `${Math.round(s / 3600)} h left` : `${Math.round(s / 86400)} days left`,
  copyLink: "Copy your link",
  copied: "Copied",
  topUp: (gap: number) => `Pay the ${u(gap)} gap and take it`,
  refund: (p: number) => `Get my ${u(p)} back`,
  refunded: "Refunded. Every cent.",
  released: "Your friends came through. It's yours.",

  referred: "A friend sent you. Haggle like they did, and your buy counts for them.",

  wallet: {
    none: "No wallet? Take a demo one. It comes with 2 test USDC.",
    getDemo: "Get a demo wallet",
    toPay: "Grab a demo wallet to pay",
    funding: "Filling it up...",
    demo: (bal: string) => `Demo wallet, ${bal} USDC`,
    low: "Out of test USDC.",
    refill: "Refill",
  },

  errors: {
    slow_down: "Easy. He can only argue so fast. Try again in a few seconds.",
    shop_closed: "He's had enough of you for today.",
    shopkeeper_unavailable: "The shopkeeper's out back. Give it a minute.",
    session_expired: "You took so long he forgot you. Walk in again.",
    chain_busy: "Solana's busy. Hit pay again, you won't be charged twice.",
    offer_used: "That deal's already paid for.",
    expired: "That handshake went cold. Haggle again.",
    payment_failed: "The payment didn't go through. Nothing was taken.",
    drip_limited: "That's all the free test money for now.",
    generic: "Something broke. Try again.",
  } as Record<string, string>,
};
