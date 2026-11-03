import nodemailer from "nodemailer";
import type { Email } from "./templates";

// Who actually sends. With MAIL_LIVE=1 it's Zoho over SMTP. Without it, nothing leaves the
// server: the email is noted in the logs (who and what subject, never the links) and dropped.

export interface Mailer {
  live: boolean;
  send(to: string, email: Email): Promise<void>;
}

export function mailSettings(env: Record<string, string | undefined> = process.env) {
  return {
    live: env.MAIL_LIVE === "1",
    host: env.ZOHO_SMTP_HOST || "smtp.zoho.eu",
    user: env.ZOHO_MAIL_USER,
    password: env.ZOHO_APP_PASSWORD,
  };
}

/** Today's limit. Never missing, never unlimited: a bad value falls back to 40, and 500 is the most. */
export function dailyCap(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.LOWBALL_MAIL_DAILY_CAP ?? 40);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, 500) : 40;
}

const masked = (to: string) => to.replace(/^(.).*@/, "$1***@");

export function logMailer(log: (s: string) => void = console.log): Mailer {
  return {
    live: false,
    async send(to, email) {
      log(`mail not sent (MAIL_LIVE is off): to=${masked(to)} subject="${email.subject}"`);
    },
  };
}

export function zohoMailer(env: Record<string, string | undefined> = process.env): Mailer {
  const s = mailSettings(env);
  if (!s.user || !s.password) throw new Error("ZOHO_MAIL_USER and ZOHO_APP_PASSWORD must be set when MAIL_LIVE=1");
  const transport = nodemailer.createTransport({
    host: s.host,
    port: 465,
    secure: true,
    auth: { user: s.user, pass: s.password },
    connectionTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return {
    live: true,
    async send(to, email) {
      await transport.sendMail({ from: { name: "Lowball", address: s.user! }, to, subject: email.subject, text: email.text, headers: email.headers });
    },
  };
}

let override: Mailer | undefined;
/** For tests. */
export function setMailer(m: Mailer | undefined) {
  override = m;
}

export function mailer(): Mailer {
  if (override) return override;
  return mailSettings().live ? zohoMailer() : logMailer();
}

/**
 * The mailer, with the dashboard's switch: real sending if MAIL_LIVE=1 is set on the server, or
 * if the dashboard turned it on (setting mail_live = "1"). Either way the Zoho settings must exist.
 */
export function mailerWith(dashboardLive: boolean): Mailer {
  if (override) return override;
  return mailSettings().live || dashboardLive ? zohoMailer() : logMailer();
}
