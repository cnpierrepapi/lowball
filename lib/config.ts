/**
 * A missing or malformed setting (a key, an address). Not a hiccup and not the chain's fault:
 * routes answer `not_set_up` so the page says so, instead of "Solana's busy".
 * Messages name the setting, never its value.
 */
export class ConfigError extends Error {}
