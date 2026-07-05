create table todos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) default auth.uid(),
  title text not null,
  done boolean not null default false,
  created_at timestamptz not null default now()
);

alter table todos enable row level security;

create policy "own todos" on todos
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
