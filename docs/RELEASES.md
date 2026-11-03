# Releases and rolling back

Every time `main` goes live, the code gets a tag, so there's always a named point to go back to.

| Tag | What it is |
|---|---|
| `v1.0` | The site before phase 2: the ebook, haggling, pay in friends. Commit `ffce661`. |
| `v2.0` | Phase 2: games, drop emails, build packs and drops, the research loop, the notebook, the back office. Merge commit `79fd64b`, live since 3 Nov 2026. |
| `v2.1` | Six research sources, the cross-check, "seen in 2 places" before any spend, thresholds 25 / 40. Merge commit `aaf2fa4`, live since 3 Nov 2026. |
| `v2.2` | Research moves to Solana developer tools: Solana Stack Exchange, the Solana forum, the chain itself; four fixes (same owner, bots, someone asking, someone said it hurts, novelty checked before spend); "seen twice" by 2 people or 2 sites. Merge commit `1eaeee4`, live since 3 Nov 2026. |
| `v2.3` | She gives ground faster (about 20% a round for a pack, 3-cent minimum, a lowball at her top price still moves her); the honesty check keeps money apart from counts; `/lab` off the live site; cleanup; README and architecture docs. Merge commit `d1e2af3`, live since 3 Nov 2026. |
| `v2.4` | "Clear non-Solana leads" in the back office. Merge commit `acc7eb9`, live since 3 Nov 2026. |
| `v2.5` | The mission check needs a real Solana or crypto word. Merge commit `b2e9b09`, live since 3 Nov 2026. |
| `v2.6` | Pay with any crypto through Aurora Intents (real money, mainnet), next to x402. Merge commit `fc5fb6c`, live since 3 Nov 2026. |

The tags exist in the local repo, but the cloud session that made the release couldn't push tags.
To put them on GitHub: Releases, "Draft a new release", type the tag name, pick the commit above
as the target, and publish.

## If something breaks on the live site

**Fastest (about a minute, no code):** in Vercel, open the project, go to Deployments, find the
last deployment that worked, open its menu and choose "Instant Rollback" (or "Promote to
Production"). The live site switches back straight away. Nothing in git changes, so the next push
to `main` goes live again as normal.

**In the code (when the fix will take a while):** undo the release on `main` with a revert commit,
which keeps the history:

```bash
git checkout main
git pull origin main
git revert -m 1 <the merge commit of the release>
git push origin main
```

`git log --merges --oneline main` lists the merge commits; each release is one.

## The database

The database only ever gets new tables and columns (`db/*.sql` never deletes anything), so rolling
the code back is safe. The older code just ignores the newer tables. Nothing in a rollback removes
data: subscribers, packs, drops and research notes stay put for when the release comes back.

## Making a release

1. Work on `phase2`. `npm test` and `npm run build` must pass.
2. Merge into `main` with a merge commit (`git merge --no-ff phase2`), so the release is one commit
   you can revert.
3. Tag it (`git tag -a v2.1 -m "..."`) and push the tag (`git push origin v2.1`).
4. Watch the Vercel deployment finish, then check `/api/health` on the live site.
