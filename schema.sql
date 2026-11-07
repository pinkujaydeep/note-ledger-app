create table if not exists public.devops_ledger (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  title text not null,
  category text not null,
  blueprint_1 text not null default '',
  blueprint_2 text not null default '',
  blueprint_3 text not null default '',
  syntax_block text not null default '',
  failure_symptom text not null default '',
  failure_root_cause text not null default '',
  failure_mitigation text not null default '',
  sketch_data text not null default ''
);

alter table public.devops_ledger enable row level security;
revoke all on table public.devops_ledger from anon, authenticated;
grant all on table public.devops_ledger to service_role;