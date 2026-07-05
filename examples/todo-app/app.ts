/**
 * Example: the official supabase-js SDK against a locally running tinbase.
 * Start the backend first:  npx tsx ../../src/cli.ts start --dir . --memory
 * Then run:                 npx tsx app.ts <anon key printed by the server>
 */
import { createClient } from '@supabase/supabase-js'

const anonKey = process.argv[2]
if (!anonKey) throw new Error('pass the anon key printed by `tinbase start`')

const supabase = createClient('http://127.0.0.1:54321', anonKey)

// 1. sign up
const { data: session } = await supabase.auth.signUp({
  email: `demo-${Date.now()}@example.com`,
  password: 'password123',
})
console.log('signed up as', session.user?.email)

// 2. subscribe to realtime changes
const channel = supabase.channel('todo-feed')
channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'todos' }, (payload) => {
  console.log('realtime insert:', payload.new)
})
await new Promise<void>((resolve) => {
  channel.subscribe((status) => status === 'SUBSCRIBED' && resolve())
})

// 3. insert rows (RLS scopes them to this user via auth.uid())
await supabase.from('todos').insert([{ title: 'Try tinbase' }, { title: 'Replace Docker' }])

// 4. query them back
const { data: todos } = await supabase.from('todos').select('title, done').order('created_at')
console.log('my todos:', todos)

await new Promise((r) => setTimeout(r, 500))
await supabase.auth.signOut()
supabase.realtime.disconnect()
process.exit(0)
