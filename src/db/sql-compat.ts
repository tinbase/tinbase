/**
 * Compatibility rewrites for user migration / seed SQL.
 *
 * tinbase can't install C extensions (pg_cron, pg_net, http, supabase_vault,
 * hypopg, …) into the PGlite or embedded-native Postgres build, and several of
 * them are emulated in pure SQL instead (cron, pg_net, pgmq — see
 * db/emulated.ts). A real Supabase project's first migration typically runs a
 * batch of `CREATE EXTENSION` statements; on stock Postgres a missing one
 * aborts the whole migration with `extension "…" is not available`.
 *
 * `tolerateExtensionStatements` wraps every *top-level* CREATE/DROP EXTENSION
 * statement in a `DO … EXCEPTION WHEN OTHERS` block (the same trick the
 * bootstrap uses for its own extension list), so an unavailable extension is
 * skipped with a NOTICE rather than aborting the migration. Extensions the
 * engine does bundle are still created normally, and the emulated schemas
 * created at bootstrap remain in place.
 *
 * It also strips `CONCURRENTLY` from index statements: tinbase applies each
 * migration inside a transaction (for atomicity + rollback), and
 * `CREATE/DROP INDEX CONCURRENTLY` / `REINDEX … CONCURRENTLY` are illegal in a
 * transaction block. On a single-connection local dev database CONCURRENTLY
 * buys nothing over a plain index, so we drop the keyword — the resulting index
 * is identical.
 *
 * The scan is quote/comment-aware so it never touches these keywords when they
 * appear inside a dollar-quoted function body, a string literal, or a comment.
 */

/**
 * Rewrite user migration / seed SQL for the local engine: make CREATE/DROP
 * EXTENSION tolerant, and strip CONCURRENTLY from index statements.
 */
export function rewriteMigrationSql(sql: string): string {
  const out: string[] = []
  const n = sql.length
  let i = 0
  let stmtStart = 0

  while (i < n) {
    const c = sql[i]

    // line comment
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? n : nl + 1
      continue
    }
    // block comment
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    // single-quoted string ('' escapes a quote)
    if (c === "'") {
      i++
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }
    // double-quoted identifier ("" escapes a quote)
    if (c === '"') {
      i++
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }
    // dollar-quoted string $tag$ … $tag$
    if (c === '$') {
      const m = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i))
      if (m) {
        const tag = m[0]
        const end = sql.indexOf(tag, i + tag.length)
        i = end === -1 ? n : end + tag.length
        continue
      }
    }
    // top-level statement terminator
    if (c === ';') {
      out.push(rewriteStatement(sql.slice(stmtStart, i + 1)))
      i++
      stmtStart = i
      continue
    }
    i++
  }
  if (stmtStart < n) out.push(rewriteStatement(sql.slice(stmtStart)))
  return out.join('')
}

const LEADING_TRIVIA = /^(?:\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/)*/

function rewriteStatement(stmt: string): string {
  const trivia = LEADING_TRIVIA.exec(stmt)?.[0] ?? ''
  const rest = stmt.slice(trivia.length)

  // CREATE/DROP EXTENSION → wrap so an unavailable extension is skipped
  if (/^(?:create|drop)\s+extension\b/i.test(rest)) {
    const semi = rest.lastIndexOf(';')
    const bare = (semi !== -1 && rest.slice(semi + 1).trim() === '' ? rest.slice(0, semi) : rest).trim()
    if (!bare) return stmt
    const inner = pickTag(bare, 'tb_ext_stmt')
    const outer = pickTag(bare, 'tb_ext')
    return (
      `${trivia}DO ${outer} BEGIN EXECUTE ${inner}${bare}${inner}; ` +
      `EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'tinbase: skipped extension statement (%)', SQLERRM; END ${outer};`
    )
  }

  // CREATE/DROP INDEX / REINDEX … CONCURRENTLY → drop CONCURRENTLY (illegal in
  // a transaction; a plain index is equivalent on a local dev database)
  if (/^(?:create\s+(?:unique\s+)?index|drop\s+index|reindex)\b/i.test(rest)) {
    return trivia + rest.replace(/\s+concurrently\b/i, ' ')
  }

  return stmt
}

/** A dollar-quote tag guaranteed not to occur in `text`. */
function pickTag(text: string, base: string): string {
  let tag = `$${base}$`
  let k = 0
  while (text.includes(tag)) tag = `$${base}_${k++}$`
  return tag
}
