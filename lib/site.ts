// The address links in emails point at: the live site in production, the preview's own address
// on a preview deploy, localhost in dev. Vercel sets these variables itself.
export function siteUrl(env: Record<string, string | undefined> = process.env): string {
  if (env.LOWBALL_SITE_URL) return env.LOWBALL_SITE_URL.replace(/\/$/, "");
  const host =
    env.VERCEL_ENV === "production" ? env.VERCEL_PROJECT_PRODUCTION_URL ?? env.VERCEL_URL : env.VERCEL_BRANCH_URL ?? env.VERCEL_URL;
  return host ? `https://${host}` : "http://localhost:3000";
}
