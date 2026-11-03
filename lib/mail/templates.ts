// The emails, word for word as approved. Plain text only.

export interface DropInfo {
  id: string;
  name: string;
  blurb: string;
  copies: number;
  opensAt: string; // ISO time
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Thu 6 Nov, 18:00 UTC" */
export function formatOpensAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error("bad opensAt");
  const two = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

export interface Email {
  subject: string;
  text: string;
  headers?: Record<string, string>;
}

export function confirmEmail(confirmLink: string): Email {
  return {
    subject: "Confirm it's you",
    text: `Someone left this email at my shop. If it was you, click here:

${confirmLink}

If it wasn't, ignore this and you'll never hear from me again.

The shopkeeper
Lowball
`,
  };
}

export function dropEmail(drop: DropInfo, links: { shop: string; unsubscribe: string }): Email {
  return {
    subject: `New in: ${drop.name}`,
    text: `Got something new.

${drop.name}
${drop.blurb}

${drop.copies} copies. Haggling opens ${formatOpensAt(drop.opensAt)}. Not before. Once they're gone, they're gone, and I don't restock.

Same rules as always. No price tag. Make me an offer.

${links.shop}

The shopkeeper

You're getting this because you signed up at Lowball. Don't want these? ${links.unsubscribe}
`,
    // One-click unsubscribe from the mail app itself (RFC 8058). Helps it land in the inbox.
    headers: {
      "List-Unsubscribe": `<${links.unsubscribe.replace("/unsubscribe?", "/api/mail/unsubscribe?")}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}
