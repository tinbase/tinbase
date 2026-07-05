import { ApiError } from '../types.js'
import { ParseError } from './parse.js'

/** HTTP status for a Postgres SQLSTATE, following PostgREST's mapping. */
function statusForSqlState(code: string): number {
  switch (code) {
    case '42501':
      return 403
    case '23503':
    case '23505':
      return 409
    case '42P01': // undefined_table
    case '42883': // undefined_function
      return 404
    case '40P01': // deadlock
    case '40001': // serialization_failure
      return 409
    case '57014': // query_canceled
      return 408
    default:
      return 400
  }
}

interface PgError {
  code?: string
  message: string
  detail?: string
  hint?: string
}

export function errorToResponse(e: unknown): Response {
  if (e instanceof ApiError) {
    return jsonResponse(e.status, e.body)
  }
  if (e instanceof ParseError) {
    return jsonResponse(400, { code: 'PGRST100', message: e.message, details: null, hint: null })
  }
  const pg = e as PgError
  if (pg && typeof pg.code === 'string' && /^[0-9A-Z]{5}$/.test(pg.code)) {
    return jsonResponse(statusForSqlState(pg.code), {
      code: pg.code,
      message: pg.message,
      details: pg.detail ?? null,
      hint: pg.hint ?? null,
    })
  }
  const message = e instanceof Error ? e.message : String(e)
  return jsonResponse(500, { code: 'PGRST500', message, details: null, hint: null })
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}
