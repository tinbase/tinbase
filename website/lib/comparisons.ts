/**
 * Single source of truth for the SEO comparison + "alternative" landing pages.
 *
 * Each competitor drives two routes:
 *   - /{id}-alternative        (marketing angle: "an X alternative that ...")
 *   - /compare/tinbase-vs-{id} (neutral, feature-by-feature comparison)
 *
 * Framing rule: honest and precise. tinbase is alpha and local-first — great
 * for local dev, prototypes, and embedded/browser use — so the copy never
 * claims production parity it doesn't have. Footprint numbers match the
 * benchmark table in the repo README and /docs#benchmarks.
 */

export type Tone = 'good' | 'neutral' | 'warn'

/** One cell in a comparison row. `tone` drives its colour, not a verdict. */
export type Cell = { label: string; tone?: Tone }

/** A single row of the tinbase-vs-competitor table. */
export type Row = { feature: string; tinbase: Cell; other: Cell }

export type Reason = { title: string; body: string; icon: string }
export type Faq = { q: string; a: string }

export type Competitor = {
  id: string
  name: string
  /** icon name from components/feature-icon.tsx used on cross-link cards */
  icon: string

  // ---- /{id}-alternative page ----
  altTitle: string
  altDescription: string
  altEyebrow: string
  /** H1 renders as: {headingLead}<accent>{name}</accent>{headingTail} */
  headingLead: string
  headingTail: string
  altIntro: string
  /** short, honest description of what the competitor actually is */
  whatItIs: string
  /** honest nuance on how far the "alternative" framing goes */
  positioning: string[]
  reasons: Reason[]

  // ---- /compare/tinbase-vs-{id} page ----
  vsTitle: string
  vsDescription: string
  vsIntro: string
  /** one-line summary of each side's sweet spot */
  tinbaseInAWord: string
  otherInAWord: string

  // ---- shared ----
  rows: Row[]
  chooseTinbase: string[]
  chooseOther: string[]
  faqs: Faq[]
}

const g = (label: string): Cell => ({ label, tone: 'good' })
const n = (label: string): Cell => ({ label, tone: 'neutral' })
const w = (label: string): Cell => ({ label, tone: 'warn' })

export const COMPETITORS: Competitor[] = [
  // ────────────────────────────────────────────────────────────── Supabase
  {
    id: 'supabase',
    name: 'Supabase',
    icon: 'database',
    altTitle: 'Supabase alternative: local Supabase without Docker',
    altDescription:
      'tinbase is a Docker-free, drop-in alternative to the Supabase CLI local stack: the same supabase-js SDK, the same migrations, real Postgres, in one process at a fraction of the memory. Alpha, open source (MIT).',
    altEyebrow: 'Docker-free Supabase alternative',
    headingLead: 'A ',
    headingTail: ' alternative that fits in a tin',
    altIntro:
      'Run local Supabase development without Docker. tinbase speaks the same wire protocols, so the official supabase-js SDK and your supabase/migrations work unchanged — in one process, at roughly 16-24x less memory than the Supabase CLI stack.',
    whatItIs:
      'Supabase is the leading open-source Postgres backend-as-a-service: a managed cloud platform plus a self-hostable stack (PostgREST, GoTrue, Storage, Realtime, Studio). Its local development story is the Supabase CLI, which boots a 12-container Docker stack.',
    positioning: [
      'tinbase is not a fork or a competitor to hosted Supabase. It is wire-compatible with it. The same supabase-js SDK, the same PostgREST query grammar, the same supabase/migrations and seed conventions all work against tinbase unchanged, so the honest way to describe it is a drop-in alternative to the Supabase CLI local stack — not to the Supabase cloud.',
      'That means the migration path runs both ways. Develop locally on tinbase with no Docker, then push the exact same migration files to hosted Supabase for production. tinbase is alpha and best for local dev, prototypes, CI, and embedded or in-browser use; hosted Supabase remains the production destination.',
    ],
    reasons: [
      {
        title: 'No Docker, no 12-container stack',
        icon: 'box',
        body: 'The Supabase CLI boots a dozen containers. tinbase is one process, or one ~58 MB binary with no Node, npm, or Docker on the machine.',
      },
      {
        title: 'The same SDK and migrations',
        icon: 'link',
        body: 'supabase-js works unchanged, and your supabase/migrations/*.sql and seed.sql apply with the same conventions and tracking table — so everything stays portable to hosted Supabase.',
      },
      {
        title: 'Boots in ~2s, ~16-24x less RAM',
        icon: 'bolt',
        body: 'Real Postgres 17 at ~59 MB (native) or ~66 MB (binary) under load, versus ~1.6 GB for the local Supabase stack. Starts serving requests in about two seconds instead of a minute.',
      },
      {
        title: 'Runs in the browser',
        icon: 'browser',
        body: 'Every service is a pure fetch handler. Hand it to supabase-js as a custom fetch and the whole backend, database included, runs in-process for previews and offline demos.',
      },
    ],
    vsTitle: 'tinbase vs Supabase',
    vsDescription:
      'How tinbase compares to Supabase: wire-compatible SDK and migrations, real Postgres with no Docker for local dev, versus the full managed Supabase platform for production. An honest, feature-by-feature comparison.',
    vsIntro:
      'tinbase and Supabase speak the same protocols, so this is less a rivalry than a division of labour: tinbase for a Docker-free local and embedded backend, hosted Supabase for the managed production platform.',
    tinbaseInAWord: 'Local dev and embedded use, no Docker, wire-compatible with Supabase.',
    otherInAWord: 'The full managed production platform, cloud-hosted and battle-tested.',
    rows: [
      { feature: 'License', tinbase: g('MIT, open source'), other: g('Apache 2.0, open source') },
      { feature: 'Database', tinbase: g('Real Postgres 17 (native or WASM)'), other: g('Managed Postgres') },
      { feature: 'Client SDK', tinbase: g('supabase-js, unchanged'), other: g('supabase-js') },
      { feature: 'Local dev without Docker', tinbase: g('Yes, one process'), other: w('No, 12-container Docker stack') },
      { feature: 'Runs in the browser / embedded', tinbase: g('Yes (PGlite / pg-mem in-process)'), other: n('No') },
      { feature: 'Memory (local dev)', tinbase: g('~59 MB native, ~66 MB binary'), other: w('~1.4-1.6 GB local stack') },
      { feature: 'Boot time (local)', tinbase: g('~2 s'), other: w('~1 min (containers)') },
      { feature: 'Self-hosting', tinbase: g('Single binary, no runtime deps'), other: n('Docker Compose / Kubernetes') },
      { feature: 'Managed cloud hosting', tinbase: w('Not yet (on the roadmap)'), other: g('Yes, mature managed platform') },
      { feature: 'Production maturity', tinbase: w('Alpha — local / prototype / embedded'), other: g('Production-ready, widely used') },
      { feature: 'Realtime', tinbase: g('postgres_changes, broadcast, presence + RLS'), other: g('Same') },
      { feature: 'Auth', tinbase: g('Email, OAuth, magic link, MFA/TOTP'), other: g('Full GoTrue incl. phone, SSO/SAML') },
      { feature: 'Storage', tinbase: g('S3-style, RLS, signed URLs, TUS'), other: g('Same, plus image transforms') },
      { feature: 'Row Level Security', tinbase: g('Postgres RLS, enforced per-request'), other: g('Postgres RLS') },
      { feature: 'Migrations', tinbase: g('supabase/migrations, portable both ways'), other: g('Same conventions') },
      { feature: 'pgvector, SSO/SAML, phone auth, image transforms', tinbase: w('Some planned'), other: g('Available') },
    ],
    chooseTinbase: [
      'You want local Supabase development without running Docker',
      'You need the backend to run in-process, in a browser tab, or inside a single binary',
      'You care about a tiny memory footprint and ~2s boot for CI and prototypes',
      'You want to keep supabase-js and your migrations portable to hosted Supabase later',
    ],
    chooseOther: [
      'You need a managed, production-grade cloud backend today',
      'You rely on features tinbase has not reached yet, such as SSO/SAML, phone auth, pgvector, or image transforms',
      'You want managed backups, scaling, dashboards, and team collaboration',
    ],
    faqs: [
      {
        q: 'Is tinbase a drop-in replacement for Supabase?',
        a: 'For local development, largely yes: tinbase is wire-compatible, so supabase-js and your supabase/migrations work unchanged. It is not a replacement for the hosted Supabase cloud in production — tinbase is alpha and aimed at local dev, prototypes, CI, and embedded or in-browser use. Hosted Supabase stays the production destination.',
      },
      {
        q: 'Do I have to rewrite my code to use tinbase?',
        a: 'No. tinbase implements the same PostgREST, GoTrue, Storage, and Realtime protocols, so you point the official supabase-js client at it and your existing queries, auth flows, and realtime subscriptions run as-is.',
      },
      {
        q: 'Can I move from tinbase to hosted Supabase later?',
        a: 'Yes, that is the intended path. tinbase reads and writes the same supabase/migrations/*.sql and seed.sql files with the same tracking table, so you push the same files to hosted Supabase when you are ready for production.',
      },
      {
        q: 'How much lighter is tinbase than local Supabase?',
        a: 'The Supabase CLI local stack runs about 12 containers at roughly 1.4-1.6 GB of RAM. tinbase serves the same APIs from one process at about 59 MB (native engine) to 66 MB (single binary) under load, and boots in about two seconds instead of a minute.',
      },
    ],
  },

  // ────────────────────────────────────────────────────────────── Firebase
  {
    id: 'firebase',
    name: 'Firebase',
    icon: 'lock',
    altTitle: 'Firebase alternative: open-source, SQL, self-hostable',
    altDescription:
      'tinbase is an open-source Firebase alternative built on real Postgres: SQL and relations instead of NoSQL, no vendor lock-in, self-hostable in a single binary, and it even runs in the browser. Alpha, MIT-licensed.',
    altEyebrow: 'Open-source Firebase alternative',
    headingLead: 'An open-source ',
    headingTail: ' alternative on real SQL',
    altIntro:
      'If you want relational SQL, your own data, and no vendor lock-in, tinbase is an open-source alternative to Firebase built on real Postgres. Auth, storage, and realtime included, self-hostable in one binary, and able to run in the browser.',
    whatItIs:
      'Firebase is Google’s proprietary, cloud-hosted backend-as-a-service: NoSQL databases (Firestore and Realtime Database), Authentication, Cloud Functions, Hosting, and a large mobile-first ecosystem including FCM push notifications. It is not open source and cannot be self-hosted.',
    positioning: [
      'tinbase and Firebase solve the same job, a backend without writing one, but from opposite ends. Firebase is proprietary, NoSQL, and cloud-only. tinbase is open source (MIT), relational Postgres, and self-hostable, so you own your data and your infrastructure.',
      'Be clear-eyed about the switch: tinbase uses the supabase-js SDK and SQL, not the Firebase SDK, so moving an existing Firebase app means rewriting data access and remodelling documents as relational tables. And tinbase is alpha, while Firebase is a mature, planet-scale managed service. The reasons to make that trade are SQL, ownership, offline and embedded use, and escaping lock-in, not feature-for-feature parity today.',
    ],
    reasons: [
      {
        title: 'Real SQL and real relations',
        icon: 'database',
        body: 'Postgres with joins, foreign keys, constraints, transactions, and jsonb, instead of denormalised NoSQL documents. Query with full SQL, not a limited document API.',
      },
      {
        title: 'Own your data, no lock-in',
        icon: 'lock',
        body: 'Open source and MIT-licensed on standard Postgres. Self-host it anywhere, export freely, and never depend on a single vendor’s proprietary APIs or pricing.',
      },
      {
        title: 'Runs offline and in the browser',
        icon: 'browser',
        body: 'Every service is a pure fetch handler, so the entire backend can run in-process in a browser tab or on-device, persisting locally, with no cloud round-trip.',
      },
      {
        title: 'Row Level Security in plain SQL',
        icon: 'transfer',
        body: 'Authorization is Postgres RLS: versionable SQL policies enforced on every request, instead of a separate security-rules DSL.',
      },
    ],
    vsTitle: 'tinbase vs Firebase',
    vsDescription:
      'tinbase vs Firebase compared: open-source Postgres and SQL with no vendor lock-in and self-hosting, versus Google’s mature, proprietary, cloud-hosted NoSQL platform. An honest look at the trade-offs.',
    vsIntro:
      'Firebase is a mature, proprietary, cloud-only NoSQL platform. tinbase is an open-source, relational, self-hostable one. They rarely swap in place: choosing between them is really choosing a data model and an ownership model.',
    tinbaseInAWord: 'Open-source SQL you own and can self-host or embed.',
    otherInAWord: 'A mature, managed, mobile-first NoSQL cloud at global scale.',
    rows: [
      { feature: 'License', tinbase: g('MIT, open source'), other: w('Proprietary (Google)') },
      { feature: 'Database', tinbase: g('Real Postgres 17'), other: n('Firestore / Realtime DB (NoSQL)') },
      { feature: 'Data model', tinbase: g('Relational: joins, FKs, constraints'), other: n('Document / key-value NoSQL') },
      { feature: 'Query language', tinbase: g('Full SQL + PostgREST'), other: n('SDK query API, limited joins') },
      { feature: 'Client SDK', tinbase: n('supabase-js'), other: n('Firebase SDK') },
      { feature: 'Self-hosting', tinbase: g('Yes, single binary'), other: w('No, Google-hosted only') },
      { feature: 'Vendor lock-in', tinbase: g('None — standard Postgres, export freely'), other: w('High — proprietary APIs & hosting') },
      { feature: 'Runs in the browser / embedded', tinbase: g('Yes, in-process'), other: n('Offline cache only, no self-host') },
      { feature: 'Managed cloud hosting', tinbase: w('Not yet (on the roadmap)'), other: g('Yes, mature global infra') },
      { feature: 'Production maturity', tinbase: w('Alpha'), other: g('Battle-tested at scale') },
      { feature: 'Realtime', tinbase: g('postgres_changes, broadcast, presence'), other: g('Firestore / RTDB listeners') },
      { feature: 'Auth', tinbase: g('Email, OAuth, magic link, MFA/TOTP'), other: g('Many providers, phone, anonymous') },
      { feature: 'Storage', tinbase: g('S3-style with RLS, signed URLs'), other: g('Cloud Storage') },
      { feature: 'Access control', tinbase: g('Postgres RLS (SQL policies)'), other: n('Security Rules (custom DSL)') },
      { feature: 'Push notifications', tinbase: w('Not built-in'), other: g('FCM, mature') },
      { feature: 'Pricing', tinbase: g('Free, open source'), other: n('Pay-as-you-go, can scale costly') },
    ],
    chooseTinbase: [
      'You want relational SQL, joins, and transactions rather than NoSQL documents',
      'You need to own your data and self-host, with no vendor lock-in',
      'You want the backend to run offline, in the browser, or embedded on-device',
      'You prefer authorization as versioned SQL policies (RLS)',
    ],
    chooseOther: [
      'You want a fully managed, planet-scale service with no infrastructure to run',
      'You depend on Google’s ecosystem: FCM push, Analytics, Crashlytics, mobile SDKs',
      'You are shipping to production now and need a battle-tested platform',
      'A document / NoSQL model fits your data better than relational tables',
    ],
    faqs: [
      {
        q: 'Is tinbase a good Firebase alternative?',
        a: 'It is a strong fit if what pulls you away from Firebase is the lack of SQL, self-hosting, or data ownership. tinbase gives you relational Postgres, open-source MIT licensing, and self-hosting in a single binary. It is not a fit if you need Firebase’s managed global scale or its mobile ecosystem today, since tinbase is alpha.',
      },
      {
        q: 'Can I migrate a Firebase app to tinbase without changes?',
        a: 'No. Firebase and tinbase use different SDKs and different data models. Moving over means switching to the supabase-js client and remodelling Firestore documents as relational Postgres tables. The upside is standard SQL and no lock-in afterwards.',
      },
      {
        q: 'Does tinbase support realtime like Firebase?',
        a: 'Yes. tinbase provides realtime through postgres_changes, broadcast, and presence, with Row Level Security applied so subscribers only receive events for rows they can see. The API is the Supabase Realtime protocol rather than Firestore listeners.',
      },
      {
        q: 'Is tinbase free?',
        a: 'Yes, tinbase is free and open source under the MIT license. You run it yourself, so there are no usage-based bills the way Firebase can accrue at scale.',
      },
    ],
  },

  // ───────────────────────────────────────────────────────────── PocketBase
  {
    id: 'pocketbase',
    name: 'PocketBase',
    icon: 'box',
    altTitle: 'PocketBase alternative: single binary on real Postgres',
    altDescription:
      'tinbase is a PocketBase-class single-binary backend that runs real Postgres (RLS, jsonb, foreign keys, triggers) behind Supabase’s wire APIs, so you use supabase-js and keep migrations portable. Alpha, open source (MIT).',
    altEyebrow: 'Single-binary PocketBase alternative',
    headingLead: 'A ',
    headingTail: ' alternative with real Postgres',
    altIntro:
      'tinbase lands in PocketBase’s weight class — one downloadable binary, no runtime prerequisite — while running real Postgres behind Supabase’s exact wire APIs. You get RLS, jsonb, foreign keys, and triggers, and you use the supabase-js SDK.',
    whatItIs:
      'PocketBase is an excellent open-source backend in a single Go binary: SQLite for storage, a built-in admin dashboard, realtime subscriptions, auth, and file storage, extensible in Go or with JavaScript hooks. It is lightweight and production-ready.',
    positioning: [
      'PocketBase and tinbase share a philosophy: one small binary, no Docker, batteries included. They differ underneath. PocketBase is SQLite with its own SDK and API rules. tinbase is real Postgres (RLS, jsonb, foreign keys, triggers) behind Supabase’s wire protocols, so you use the standard supabase-js client and your migrations stay portable to hosted Supabase.',
      'Be honest about the trade: PocketBase is lighter (about 24 MB under load versus tinbase’s ~66 MB binary) and it is production-ready today, whereas tinbase is alpha. Choose tinbase when you want Postgres semantics and the Supabase ecosystem in that same single-binary form factor, or when you need the backend to run in the browser.',
    ],
    reasons: [
      {
        title: 'PocketBase’s form factor, real Postgres',
        icon: 'box',
        body: 'One downloadable binary with no Node, npm, or Docker, but backed by Postgres 17 rather than SQLite — RLS, jsonb, foreign keys, and triggers included.',
      },
      {
        title: 'Use the Supabase SDK and ecosystem',
        icon: 'link',
        body: 'Talk to it with the official supabase-js client and the PostgREST query grammar, and keep your supabase/migrations portable to hosted Supabase.',
      },
      {
        title: 'Postgres power, per-request RLS',
        icon: 'database',
        body: 'Full SQL, PL/pgSQL, triggers, and Row Level Security enforced on every REST, Storage, and realtime request with your JWT claims applied.',
      },
      {
        title: 'Runs in the browser too',
        icon: 'browser',
        body: 'Beyond the server binary, tinbase can run in-process in a browser tab via PGlite or the pure-JS pg-mem engine, for previews and offline apps.',
      },
    ],
    vsTitle: 'tinbase vs PocketBase',
    vsDescription:
      'tinbase vs PocketBase: two single-binary, Docker-free backends compared. PocketBase is the lightest, on SQLite with its own SDK; tinbase runs real Postgres behind Supabase’s wire APIs. An honest comparison.',
    vsIntro:
      'Both are single-binary, batteries-included backends with no Docker. The real question is SQLite and PocketBase’s own API versus Postgres and the Supabase ecosystem, weighed against PocketBase being lighter and production-ready today.',
    tinbaseInAWord: 'Single-binary Postgres, wire-compatible with Supabase.',
    otherInAWord: 'The lightest single-binary backend, on SQLite, production-ready.',
    rows: [
      { feature: 'License', tinbase: g('MIT, open source'), other: g('MIT, open source') },
      { feature: 'Runtime', tinbase: n('Node, or standalone binary'), other: g('Go, standalone binary') },
      { feature: 'Database', tinbase: g('Real Postgres 17'), other: n('SQLite') },
      { feature: 'Postgres features (RLS, jsonb, FKs, triggers)', tinbase: g('Yes'), other: n('SQLite equivalents only') },
      { feature: 'Client SDK', tinbase: g('supabase-js'), other: n('PocketBase SDK (JS / Dart)') },
      { feature: 'Single binary', tinbase: g('Yes, ~58 MB'), other: g('Yes, ~30 MB') },
      { feature: 'Memory under load', tinbase: n('~66 MB (binary)'), other: g('~24 MB') },
      { feature: 'Runs in the browser / embedded', tinbase: g('Yes (PGlite / pg-mem)'), other: n('No, server only') },
      { feature: 'Realtime', tinbase: g('postgres_changes, broadcast, presence + RLS'), other: g('Realtime subscriptions') },
      { feature: 'Auth', tinbase: g('Email, OAuth, magic link, MFA/TOTP'), other: g('Email, OAuth, OTP') },
      { feature: 'Storage', tinbase: g('S3-style, RLS, signed URLs, TUS'), other: g('File storage, S3 backend') },
      { feature: 'Admin dashboard', tinbase: g('Studio (Supabase-style) at /_/'), other: g('Built-in admin UI') },
      { feature: 'Access control', tinbase: g('Postgres RLS (SQL policies)'), other: n('Collection API rules') },
      { feature: 'Extensibility', tinbase: g('SQL, Edge Functions, webhooks, cron'), other: g('Go extensions / JS hooks') },
      { feature: 'Ecosystem portability', tinbase: g('supabase-js + migrations portable to Supabase'), other: n('PocketBase-specific') },
      { feature: 'Production maturity', tinbase: w('Alpha'), other: g('Production-ready, mature') },
    ],
    chooseTinbase: [
      'You want real Postgres semantics (RLS, jsonb, FKs, triggers), not SQLite',
      'You want the Supabase SDK and migrations that stay portable to hosted Supabase',
      'You need the backend to run in a browser tab or embedded, not just as a server',
      'Per-request Row Level Security in SQL matters to you',
    ],
    chooseOther: [
      'You want the absolute lightest footprint (~24 MB under load)',
      'You are shipping to production now and want a mature, proven backend',
      'SQLite fits your workload and you like extending the backend in Go',
      'A single self-contained file with the smallest possible surface is the priority',
    ],
    faqs: [
      {
        q: 'How is tinbase different from PocketBase?',
        a: 'Both are single-binary, Docker-free backends. PocketBase uses SQLite and its own SDK and API rules. tinbase runs real Postgres (RLS, jsonb, foreign keys, triggers) behind Supabase’s wire protocols, so you use supabase-js and keep migrations portable to hosted Supabase. PocketBase is lighter and production-ready; tinbase is alpha.',
      },
      {
        q: 'Is tinbase as lightweight as PocketBase?',
        a: 'Close, but PocketBase is lighter. PocketBase runs at about 24 MB of RAM under load; the tinbase single binary is about 66 MB. tinbase trades that extra footprint for a full Postgres engine and Supabase-compatible APIs.',
      },
      {
        q: 'Does tinbase have an admin UI like PocketBase?',
        a: 'Yes. tinbase ships Studio, a Supabase-Studio-style dashboard, at /_/. It includes a table editor, SQL editor, auth and RLS management, storage, and logs, and it compiles into the single binary.',
      },
      {
        q: 'Can I use Postgres features PocketBase’s SQLite lacks?',
        a: 'Yes. Because tinbase is real Postgres, you get jsonb, foreign keys, triggers, PL/pgSQL, Row Level Security, and the wider Postgres extension surface, all through the standard supabase-js client.',
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────── Appwrite
  {
    id: 'appwrite',
    name: 'Appwrite',
    icon: 'transfer',
    altTitle: 'Appwrite alternative: no Docker, real Postgres, tiny footprint',
    altDescription:
      'tinbase is a Docker-free Appwrite alternative: real Postgres and SQL in a single process instead of a multi-container Docker deployment, small enough to run in the browser. Uses supabase-js. Alpha, open source (MIT).',
    altEyebrow: 'Docker-free Appwrite alternative',
    headingLead: 'An ',
    headingTail: ' alternative with no Docker',
    altIntro:
      'tinbase is an open-source alternative to Appwrite that skips Docker entirely. Real Postgres and full SQL in a single process or binary, small enough to run in a browser tab, talking to the supabase-js SDK.',
    whatItIs:
      'Appwrite is a popular open-source backend-as-a-service: a document-style database over MariaDB, plus auth, storage, functions, realtime, and messaging, with SDKs for many languages. You self-host it with Docker Compose (a multi-container deployment) or use Appwrite Cloud.',
    positioning: [
      'Appwrite and tinbase are both open-source BaaS, but the deployment shape is the sharpest difference. Appwrite self-hosting means a multi-container Docker Compose stack over MariaDB. tinbase is a single process, or one binary, running real Postgres, light enough to run in the browser.',
      'The honest trade-offs: Appwrite is production-ready, ships SDKs for many languages, and has built-in messaging and a rich console. tinbase is alpha, uses the supabase-js SDK (so moving an Appwrite app means rewriting data access), and gives you relational Postgres and SQL with a far smaller footprint. Choose tinbase when Docker-free, lightweight, SQL-native, or embeddable matters more than breadth today.',
    ],
    reasons: [
      {
        title: 'No Docker, one process',
        icon: 'box',
        body: 'Appwrite self-hosting is a multi-container Docker Compose stack. tinbase is a single process, or one ~58 MB binary, with nothing else to install.',
      },
      {
        title: 'Real Postgres and full SQL',
        icon: 'database',
        body: 'Relational Postgres with joins, foreign keys, transactions, jsonb, and the PostgREST query grammar, instead of a document API over MariaDB.',
      },
      {
        title: 'A footprint you can put anywhere',
        icon: 'bolt',
        body: 'Roughly 59-66 MB of RAM and a ~2s boot, versus a GB-scale multi-container deployment. Light enough for CI, laptops, and previews.',
      },
      {
        title: 'Runs in the browser',
        icon: 'browser',
        body: 'Because every service is a pure fetch handler, the whole backend can run in-process in a browser tab, which a Docker-based platform cannot do.',
      },
    ],
    vsTitle: 'tinbase vs Appwrite',
    vsDescription:
      'tinbase vs Appwrite compared: a Docker-free, single-process Postgres backend versus Appwrite’s multi-container, multi-SDK open-source platform on MariaDB. An honest, feature-by-feature look.',
    vsIntro:
      'Both are open-source backends-as-a-service. The split is deployment and data model: tinbase is one Docker-free process on Postgres with the Supabase SDK, while Appwrite is a mature multi-container platform on MariaDB with SDKs for many languages.',
    tinbaseInAWord: 'Docker-free single-process Postgres, wire-compatible with Supabase.',
    otherInAWord: 'A mature multi-SDK platform, self-hosted via Docker.',
    rows: [
      { feature: 'License', tinbase: g('MIT, open source'), other: g('BSD-3, open source') },
      { feature: 'Database', tinbase: g('Real Postgres 17'), other: n('MariaDB (document-style)') },
      { feature: 'Data model', tinbase: g('Relational SQL'), other: n('Collections / documents') },
      { feature: 'Query language', tinbase: g('Full SQL + PostgREST'), other: n('Query SDK, no raw SQL') },
      { feature: 'Client SDK', tinbase: n('supabase-js (JS/TS)'), other: g('SDKs for many languages') },
      { feature: 'Runs without Docker', tinbase: g('Yes, one process / binary'), other: w('No, Docker Compose (multi-container)') },
      { feature: 'Footprint', tinbase: g('~59-66 MB'), other: w('Multi-container, GB-scale') },
      { feature: 'Runs in the browser / embedded', tinbase: g('Yes'), other: n('No') },
      { feature: 'Self-hosting', tinbase: g('Single binary, no runtime deps'), other: n('Docker self-host') },
      { feature: 'Managed cloud hosting', tinbase: w('Not yet (on the roadmap)'), other: g('Appwrite Cloud') },
      { feature: 'Realtime', tinbase: g('postgres_changes, broadcast, presence + RLS'), other: g('Realtime subscriptions') },
      { feature: 'Auth', tinbase: g('Email, OAuth, magic link, MFA/TOTP'), other: g('Many providers, phone, teams') },
      { feature: 'Storage', tinbase: g('S3-style, RLS, signed URLs, TUS'), other: g('File storage, image transforms') },
      { feature: 'Messaging (email / SMS / push)', tinbase: w('Via functions/webhooks, not built-in'), other: g('Built-in Messaging') },
      { feature: 'Access control', tinbase: g('Postgres RLS (SQL policies)'), other: n('Document-level permissions') },
      { feature: 'Production maturity', tinbase: w('Alpha'), other: g('Production-ready') },
    ],
    chooseTinbase: [
      'You want to avoid Docker and run one process or a single binary',
      'You want relational Postgres and full SQL rather than a document API',
      'You need a small footprint or to run the backend in the browser',
      'You want supabase-js and migrations portable to hosted Supabase',
    ],
    chooseOther: [
      'You need SDKs across many languages (Flutter, Apple, Android, and more)',
      'You want built-in messaging (email, SMS, push) and a rich console today',
      'You are shipping to production now and want a mature platform',
      'You are comfortable running a Docker Compose deployment',
    ],
    faqs: [
      {
        q: 'What is the main difference between tinbase and Appwrite?',
        a: 'Deployment and data model. Appwrite self-hosts as a multi-container Docker Compose stack over MariaDB with a document-style API. tinbase runs as a single Docker-free process on real Postgres with full SQL and the supabase-js SDK. Appwrite is production-ready with more language SDKs; tinbase is alpha, lighter, and embeddable.',
      },
      {
        q: 'Can tinbase run without Docker like Appwrite requires?',
        a: 'Yes. Avoiding Docker is a core reason to pick tinbase. It runs as one process (npx tinbase start) or a single self-contained binary, with no containers to orchestrate.',
      },
      {
        q: 'Does tinbase support many language SDKs like Appwrite?',
        a: 'Not today. tinbase targets the JavaScript and TypeScript ecosystem through supabase-js. Appwrite ships official SDKs for many languages and platforms, so if you need broad native mobile SDK coverage, Appwrite is stronger there right now.',
      },
      {
        q: 'Is tinbase lighter than Appwrite?',
        a: 'Considerably. A self-hosted Appwrite is a multi-container deployment measured in gigabytes; tinbase serves comparable core APIs from one process at roughly 59-66 MB of RAM, and can even run in a browser tab.',
      },
    ],
  },
]

const BY_ID = new Map(COMPETITORS.map((c) => [c.id, c]))

export function getCompetitor(id: string): Competitor | undefined {
  return BY_ID.get(id)
}

/** '/{id}-alternative' slug used by the top-level [slug] route. */
export function altSlug(c: Competitor): string {
  return `${c.id}-alternative`
}

/** '/compare/tinbase-vs-{id}' slug used by the compare/[slug] route. */
export function vsSlug(c: Competitor): string {
  return `tinbase-vs-${c.id}`
}

export const ALT_SLUGS = COMPETITORS.map(altSlug)
export const VS_SLUGS = COMPETITORS.map(vsSlug)

/** Resolve an "/{id}-alternative" slug back to its competitor. */
export function competitorFromAltSlug(slug: string): Competitor | undefined {
  const m = /^(.+)-alternative$/.exec(slug)
  return m ? getCompetitor(m[1]) : undefined
}

/** Resolve a "tinbase-vs-{id}" slug back to its competitor. */
export function competitorFromVsSlug(slug: string): Competitor | undefined {
  const m = /^tinbase-vs-(.+)$/.exec(slug)
  return m ? getCompetitor(m[1]) : undefined
}
