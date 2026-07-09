import { afterEach, describe, expect, it } from 'vitest'
import { createBackend, type TinbaseBackend } from '../src/index.js'
import { rewriteMigrationSql } from '../src/db/sql-compat.js'

// Regression coverage for running a real Supabase project's migrations
// (github.com/Cap-go/capgo) unchanged: extension tolerance, search_path
// isolation between files, CONCURRENTLY stripping, and the pgmq/vault/
// moddatetime/auth.users compatibility surface.

// Each test spins up a fresh backend (PGlite cold boot is slow under the
// full-suite's parallel load), so allow generous time.
const T = 30_000

let backend: TinbaseBackend | null = null
afterEach(async () => {
  if (backend) await backend.close()
  backend = null
})

describe('migration compatibility', () => {
  it(
    'tolerates CREATE EXTENSION for unavailable extensions and keeps going',
    async () => {
      backend = await createBackend({
        migrations: [
          {
            name: '20240101000000_ext',
            sql: `create extension if not exists "pg_cron" with schema extensions;
                  create extension if not exists "http";
                  create table ext_ok (id int);`,
          },
        ],
      })
      const r = await backend.db.query(`select 1 from information_schema.tables where table_name = 'ext_ok'`)
      expect(r.rows.length).toBe(1)
    },
    T
  )

  it(
    "a migration's SET search_path='' does not leak into the next file",
    async () => {
      backend = await createBackend({
        migrations: [
          { name: '20240101000001_a', sql: `set search_path to '';` },
          {
            name: '20240101000002_b',
            // unqualified gen_random_bytes must still resolve (extensions on path)
            sql: `create table sp_ok (id int, tok text default encode(gen_random_bytes(8), 'hex'));
                  insert into sp_ok (id) values (1);`,
          },
        ],
      })
      const r = await backend.db.query(`select tok from sp_ok where id = 1`)
      expect((r.rows[0] as { tok: string }).tok).toMatch(/^[0-9a-f]{16}$/)
    },
    T
  )

  it(
    'runs CREATE INDEX CONCURRENTLY inside a migration (CONCURRENTLY stripped)',
    async () => {
      backend = await createBackend({
        migrations: [
          {
            name: '20240101000003_idx',
            sql: `create table idx_t (id int);
                  create index concurrently if not exists idx_t_id on idx_t (id);`,
          },
        ],
      })
      const r = await backend.db.query(`select 1 from pg_indexes where indexname = 'idx_t_id'`)
      expect(r.rows.length).toBe(1)
    },
    T
  )

  it(
    'pgmq: drop_queue / purge_queue / list_queues',
    async () => {
      backend = await createBackend({})
      await backend.db.query(`select pgmq.create('q1')`)
      await backend.db.query(`select pgmq.send('q1', '{"a":1}'::jsonb)`)
      const purged = await backend.db.query(`select pgmq.purge_queue('q1') as n`)
      expect(Number((purged.rows[0] as { n: number }).n)).toBe(1)
      const list = await backend.db.query(`select queue_name from pgmq.list_queues()`)
      expect(list.rows.map((r) => (r as { queue_name: string }).queue_name)).toContain('q1')
      const dropped = await backend.db.query(`select pgmq.drop_queue('q1') as ok`)
      expect((dropped.rows[0] as { ok: boolean }).ok).toBe(true)
      const after = await backend.db.query(`select queue_name from pgmq.list_queues()`)
      expect(after.rows.map((r) => (r as { queue_name: string }).queue_name)).not.toContain('q1')
    },
    T
  )

  it(
    'vault: create_secret is readable via decrypted_secrets',
    async () => {
      backend = await createBackend({})
      await backend.db.query(`select vault.create_secret('s3cr3t', 'apikey', 'my key')`)
      const r = await backend.db.query(`select decrypted_secret from vault.decrypted_secrets where name = 'apikey'`)
      expect((r.rows[0] as { decrypted_secret: string }).decrypted_secret).toBe('s3cr3t')
      // the stored column must be ciphertext, not the plaintext (encryption at rest)
      const raw = await backend.db.query(`select secret from vault.secrets where name = 'apikey'`)
      expect((raw.rows[0] as { secret: string }).secret).not.toContain('s3cr3t')
    },
    T
  )

  it(
    'moddatetime: stamps the timestamp column on update',
    async () => {
      backend = await createBackend({
        migrations: [
          {
            name: '20240101000004_mod',
            sql: `create table mt (id int primary key, updated_at timestamptz default now());
                  create trigger mt_upd before update on mt for each row execute function extensions.moddatetime(updated_at);
                  insert into mt (id, updated_at) values (1, '2000-01-01');`,
          },
        ],
      })
      await backend.db.query(`update mt set id = 1 where id = 1`)
      const r = await backend.db.query(`select updated_at from mt where id = 1`)
      expect(new Date((r.rows[0] as { updated_at: string }).updated_at).getFullYear()).toBeGreaterThan(2020)
    },
    T
  )

  it(
    'auth.users accepts a full GoTrue row (instance_id, email_change*, reauthentication*)',
    async () => {
      backend = await createBackend({})
      await backend.db.query(
        `insert into auth.users (instance_id, id, aud, role, email, confirmation_token, email_change,
          email_change_confirm_status, phone_change, reauthentication_token)
         values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
          'full@row.com', '', '', 0, '', '')`
      )
      const r = await backend.db.query(`select instance_id from auth.users where email = 'full@row.com'`)
      expect(r.rows.length).toBe(1)
    },
    T
  )
})

describe('rewriteMigrationSql', () => {
  it('leaves create extension / concurrently alone inside dollar-quoted bodies', () => {
    const sql = `create function f() returns text language plpgsql as $$ begin return 'create extension foo; create index concurrently x'; end $$;`
    expect(rewriteMigrationSql(sql)).toBe(sql)
  })

  it('wraps a top-level CREATE EXTENSION and strips CONCURRENTLY', () => {
    const out = rewriteMigrationSql(`create extension if not exists "pg_cron"; create index concurrently i on t (a);`)
    expect(out).toContain('DO $tb_ext$')
    expect(out).not.toMatch(/create\s+index\s+concurrently/i)
  })
})
