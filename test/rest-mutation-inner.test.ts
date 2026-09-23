import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBackend, type TinbaseBackend } from '../src/index.js'
import { testEngine } from './helpers.js'

const MIGRATION = `
create table people (id int primary key, name text not null);
create table assignments (
  id int primary key,
  person_id int references people(id),
  role text not null
);
insert into people values (1, 'Ada'), (2, 'Linus');
insert into assignments values (1, 1, 'viewer'), (2, 2, 'viewer'), (3, null, 'viewer'), (6, null, 'viewer'), (7, null, 'viewer'), (8, 1, 'viewer'), (9, null, 'viewer');
`

let backend: TinbaseBackend
let client: SupabaseClient

beforeAll(async () => {
  backend = await createBackend({
    engine: await testEngine(),
    migrations: [{ name: '20240101000000_mutation_inner', sql: MIGRATION }],
  })
  client = createClient('http://localhost:54321', backend.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => backend.fetch(new Request(input, init)) },
  })
})

afterAll(async () => {
  await backend.close()
})

describe('mutation representations with !inner embeds', () => {
  it('PATCH returns an aliased to-one embed and persists the update', async () => {
    const { data, error } = await client
      .from('assignments')
      .update({ role: 'editor' })
      .eq('id', 1)
      .select('id,role,person:people!inner(id,name)')
      .single()

    expect(error).toBeNull()
    expect(data).toEqual({ id: 1, role: 'editor', person: { id: 1, name: 'Ada' } })
    const persisted = await client.from('assignments').select('role').eq('id', 1).single()
    expect(persisted.data?.role).toBe('editor')
  })

  it('PATCH filters only the representation with an alias-scoped condition', async () => {
    const { data, error } = await client
      .from('assignments')
      .update({ role: 'reviewer' })
      .in('id', [1, 2, 3])
      .select('id,role,person:people!inner(name)')
      .eq('person.name', 'Ada')

    expect(error).toBeNull()
    expect(data).toEqual([{ id: 1, role: 'reviewer', person: { name: 'Ada' } }])
    const persisted = await client.from('assignments').select('id,role').in('id', [1, 2, 3]).order('id')
    expect(persisted.data).toEqual([
      { id: 1, role: 'reviewer' },
      { id: 2, role: 'reviewer' },
      { id: 3, role: 'reviewer' },
    ])
  })

  it('INSERT writes all rows but returns only those matching !inner', async () => {
    const { data, error } = await client
      .from('assignments')
      .insert([
        { id: 4, person_id: 1, role: 'new' },
        { id: 5, person_id: null, role: 'new' },
      ])
      .select('id,person:people!inner(name)')

    expect(error).toBeNull()
    expect(data).toEqual([{ id: 4, person: { name: 'Ada' } }])
    const persisted = await client.from('assignments').select('id').in('id', [4, 5]).order('id')
    expect(persisted.data).toEqual([{ id: 4 }, { id: 5 }])
  })

  it('DELETE removes all targeted rows but filters the representation', async () => {
    const { data, error } = await client
      .from('assignments')
      .delete()
      .in('id', [2, 3])
      .select('id,person:people!inner(name)')

    expect(error).toBeNull()
    expect(data).toEqual([{ id: 2, person: { name: 'Linus' } }])
    const persisted = await client.from('assignments').select('id').in('id', [2, 3])
    expect(persisted.data).toEqual([])
  })

  it('rejects filters on a relationship absent from the select', async () => {
    const { error } = await client.from('assignments').update({ role: 'invalid' }).eq('person.name', 'Ada').select('id')
    expect(error?.code).toBe('PGRST108')
  })

  it('returns an empty representation without undoing the write', async () => {
    const { data, error } = await client
      .from('assignments')
      .update({ role: 'hidden' })
      .eq('id', 6)
      .select('id,person:people!inner(name)')
    expect(error).toBeNull()
    expect(data).toEqual([])
    const persisted = await client.from('assignments').select('role').eq('id', 6).single()
    expect(persisted.data?.role).toBe('hidden')
  })

  it('rolls back a singular mutation whose filtered representation is empty', async () => {
    const { error } = await client.from('assignments').update({ role: 'hidden' }).eq('id', 7)
      .select('id,person:people!inner(name)').single()
    expect(error?.code).toBe('PGRST116')
    const persisted = await client.from('assignments').select('role').eq('id', 7).single()
    expect(persisted.data?.role).toBe('viewer')
  })

  it('rolls back a singular mutation that affects several rows', async () => {
    const { error } = await client.from('assignments').update({ role: 'many' }).in('id', [7, 9]).select('id').single()
    expect(error?.code).toBe('PGRST116')
    const persisted = await client.from('assignments').select('id,role').in('id', [7, 9]).order('id')
    expect(persisted.data).toEqual([{ id: 7, role: 'viewer' }, { id: 9, role: 'viewer' }])
  })

  it('DELETE filters the representation with an alias-scoped condition', async () => {
    await client.from('assignments').insert([
      { id: 10, person_id: 1, role: 'gone' },
      { id: 11, person_id: 2, role: 'gone' },
    ])
    const { data, error } = await client
      .from('assignments')
      .delete()
      .in('id', [10, 11])
      .select('id,person:people!inner(name)')
      .eq('person.name', 'Linus')

    expect(error).toBeNull()
    expect(data).toEqual([{ id: 11, person: { name: 'Linus' } }])
    const persisted = await client.from('assignments').select('id').in('id', [10, 11])
    expect(persisted.data).toEqual([])
  })

  it('reports the filtered response range for a direct count=exact request', async () => {
    const response = await backend.fetch(new Request(
      'http://localhost:54321/rest/v1/assignments?id=in.(8,9)&select=id,person:people!inner(name)',
      {
        method: 'PATCH',
        headers: {
          apikey: backend.serviceRoleKey,
          Authorization: `Bearer ${backend.serviceRoleKey}`,
          Prefer: 'return=representation,count=exact',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'counted' }),
      }
    ))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-range')).toBe('0-0/1')
    expect(await response.json()).toEqual([{ id: 8, person: { name: 'Ada' } }])
    const persisted = await client.from('assignments').select('id,role').in('id', [8, 9]).order('id')
    expect(persisted.data).toEqual([{ id: 8, role: 'counted' }, { id: 9, role: 'counted' }])
  })
})
