// tinbase edge function: default-export a fetch handler
export default async function handler(req, ctx) {
  const { name = 'world' } = await req.json().catch(() => ({}))
  return new Response(JSON.stringify({ message: `Hello ${name}!`, role: ctx.auth.role }), {
    headers: { 'content-type': 'application/json' },
  })
}
