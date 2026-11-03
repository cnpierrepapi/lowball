import { db } from "../db";
import { siteUrl } from "../site";
import { dailyCap } from "../mail/mailer";
import { activeMailer } from "../mail/service";
import { claudeResearch, type ResearchModel } from "./model";
import type { Deps } from "./loop";

// The research loop wired to the real database, the real model, and the mailer in force.

let modelOverride: ResearchModel | undefined;
/** For tests. */
export function setResearchModel(m: ResearchModel | undefined) {
  modelOverride = m;
}

export async function liveDeps(): Promise<Deps | undefined> {
  const d = db();
  if (!d) return undefined;
  return { db: d, model: modelOverride ?? claudeResearch, mailer: await activeMailer(), mailCap: dailyCap(), site: siteUrl() };
}
