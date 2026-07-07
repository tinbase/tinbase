# tinbase roadmap

## North Star

**A developer can run `tinbase start` instead of `supabase start` and build almost any app without noticing the difference — no Docker, one process, real Postgres.**

The measure of success is not a feature checklist; it is: *take a real Supabase project, point supabase-js at tinbase, and everything the app does just works.*

## Scope: what we match, and what we deliberately don't

tinbase targets **the local Supabase development stack** (`supabase start`), not Supabase Cloud the company.

**In scope** (this is what "almost everything" means):

- Postgres + the extensions Supabase enables locally
- REST (PostgREST), Auth (GoTrue), Storage, Realtime, Edge Functions
- Studio, migrations, seed, type generation, local email testing
- The behaviors, error shapes, and defaults a local Supabase project relies on

**Out of scope** (Cloud platform, not local dev — never our goal):

- Hosting, projects/org management API, billing
- Supavisor connection pooling, read replicas, HA/PITR
- Branching against a remote, Logflare cloud analytics
- Anything you cannot get from `supabase start` today

Keeping this line bright is what keeps the goal achievable. When unsure whether
to build something, ask: *does `supabase start` give it to a developer locally?*
If no, it's out of scope.

## Definition of done: the parity harness

The durable, objective measure (build this early — it makes every later phase self-checking):

- A suite that runs the **same** supabase-js programs against (a) a real `supabase start` stack and (b) tinbase, and **diffs the results** — data, status codes, error codes, headers.
- A conformance report: “X of Y behaviors match.” That number, not our own estimate, becomes the scoreboard.
- Green parity on a scenario = that scenario is genuinely 1:1.

Until the harness exists, coverage numbers below are our own honest estimates.

## Current state (v0.2.2)

| Module | Coverage | Biggest gaps |
| --- | --- | --- |
| Database (PostgREST) | ~85% | aggregates in select, `.explain()`, `.csv()`, full spread embeds |
| Auth (GoTrue) | ~80% | MFA, SSO, phone auth, anonymous→permanent upgrade |
| Storage | ~80% | image transforms, resumable (TUS) uploads |
| Realtime | ~85% | per-row DELETE RLS (WALRUS), private channels, broadcast-from-db |
| Edge Functions | ~60% | Deno runtime compat, secrets |
| Studio | basic | RLS policy editor, functions/triggers UI, logs |
| Type generation | 0% | `gen types typescript` |
| Extensions (pgvector, pg_cron, pg_net, pgmq) | partial/0% | vector search, cron, webhooks, queues |

Typical CRUD + auth + storage + realtime app: **~90%** already works.

## Phases (ordered by real-app impact)

Each phase ships independently, keeps 100% test green on both engines, and moves
the "runs my real app" bar forward. Check items off as they land.

### Phase 0 — Parity harness (infrastructure)
- [x] Shared scenario programs (supabase-js) — `parity/scenarios.ts`
- [x] Self-scored harness runs against tinbase on both engines — `npm run parity` (14/14)
- [x] `--compare` diffs normalized results against a real `supabase start` (needs Docker)
- [ ] Wire `--compare` into CI as an informational job (once a CI Docker path is set up)

### Phase 1 — Auth completeness (the #1 real-app blocker)
- [x] OAuth providers (Google, GitHub presets + generic) — `signInWithOAuth()` end to end
- [x] PKCE flow (`exchangeCodeForSession`)
- [ ] MFA / TOTP enroll + challenge + verify
- [x] Identity linking by email (auth.identities); [ ] anonymous → permanent upgrade
- [ ] Local email inbox UI (like Inbucket/Mailpit) for magic-link/OTP testing
- Target: Auth ~65% → ~90%

### Phase 2 — Realtime correctness
- [x] RLS-filtered `postgres_changes` (INSERT/UPDATE by PK re-query; DELETE limited — see note)
- [ ] Private channels with authorization
- [ ] Broadcast-from-database
- Target: Realtime ~70% → ~90%; closes a real security gap

### Phase 3 — Developer experience
- [ ] `tinbase gen types typescript` from the live schema
- [ ] CLI parity: `db reset`, `db diff`, `db pull`, status/inspect
- [ ] Studio: RLS policy editor, functions/triggers browser, logs pane
- Target: match the daily-driver DX of the Supabase CLI + Studio

### Phase 4 — Extensions & automation
- [ ] pgvector (embeddings / similarity search)
- [ ] pg_net (database webhooks)
- [ ] pg_cron (scheduled jobs)
- [ ] pgmq (queues)
- Target: AI + automation apps run unchanged

### Phase 5 — Edge Functions runtime fidelity
- [ ] Deno-compatible execution (or a documented, tested shim path)
- [ ] Function secrets; local invoke parity with `supabase functions serve`
- Target: real Supabase functions run with no edits

### Phase 6 — Storage & PostgREST fidelity edges
- [ ] Storage image transformations; resumable (TUS) uploads
- [ ] PostgREST aggregates-in-select, `.explain()`, `.csv()`, spread embeds
- [ ] Error-shape matching verified by the parity harness

## Working principles (so the goal survives across sessions)

1. **Every change keeps the full suite green on both engines** (`npm test` and `TINBASE_TEST_ENGINE=native npm test`).
2. **Every new surface gets a test written against the real supabase-js**, not a bespoke client.
3. **Prefer real Postgres/extension behavior over shims** where the engine supports it; shim only for cross-engine (browser) parity.
4. **Update the coverage table here** when a phase item lands, so this file is always the current truth.
5. **When a real project reveals a gap** (like the uuid-ossp and stale-pid fixes did), add a regression test and, if it points to a whole missing area, a roadmap item.

## How to pick up work

Read this file → find the first unchecked item in the lowest-numbered phase →
build it → keep the suite green → check it off and update the coverage table.
