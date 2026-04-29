create extension if not exists pgcrypto;

create table if not exists public.colaboradores (
  id uuid primary key default gen_random_uuid(),
  person_id_nexti bigint not null unique,
  matricula text,
  nome text not null,
  cargo text,
  posto text,
  empresa text,
  situacao text,
  ultima_atualizacao timestamptz,
  raw_json jsonb not null default '{}'::jsonb,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create table if not exists public.atestados (
  id uuid primary key default gen_random_uuid(),
  id_nexti bigint not null unique,
  person_id_nexti bigint not null references public.colaboradores(person_id_nexti) on update cascade,
  matricula text,
  data_inicio date not null,
  data_fim date not null,
  dias integer not null check (dias > 0),
  data_lancamento timestamptz,
  lancado_por text,
  cid text,
  observacao text,
  tipo_ausencia_id bigint,
  tipo_ausencia_external_id text,
  removido boolean not null default false,
  raw_json jsonb not null default '{}'::jsonb,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create table if not exists public.sincronizacoes (
  id uuid primary key default gen_random_uuid(),
  iniciado_em timestamptz not null default now(),
  finalizado_em timestamptz,
  status text not null default 'em_execucao' check (status in ('em_execucao', 'sucesso', 'erro')),
  periodo_inicio timestamptz,
  periodo_fim timestamptz,
  quantidade_importada integer not null default 0,
  quantidade_atualizada integer not null default 0,
  erro text,
  detalhes jsonb not null default '{}'::jsonb
);

create index if not exists idx_atestados_periodo on public.atestados (data_inicio, data_fim);
create index if not exists idx_atestados_person_id_nexti on public.atestados (person_id_nexti);
create index if not exists idx_atestados_status_periodo on public.atestados (removido, data_inicio, data_fim);
create index if not exists idx_sincronizacoes_inicio on public.sincronizacoes (iniciado_em desc);

create or replace function public.set_atualizado_em()
returns trigger
language plpgsql
as $$
begin
  new.atualizado_em = now();
  return new;
end;
$$;

drop trigger if exists trg_colaboradores_atualizado_em on public.colaboradores;
create trigger trg_colaboradores_atualizado_em
before update on public.colaboradores
for each row execute function public.set_atualizado_em();

drop trigger if exists trg_atestados_atualizado_em on public.atestados;
create trigger trg_atestados_atualizado_em
before update on public.atestados
for each row execute function public.set_atualizado_em();

alter table public.colaboradores enable row level security;
alter table public.atestados enable row level security;
alter table public.sincronizacoes enable row level security;

drop policy if exists "colaboradores_select_authenticated" on public.colaboradores;
create policy "colaboradores_select_authenticated"
on public.colaboradores
for select
to authenticated
using (true);

drop policy if exists "atestados_select_authenticated" on public.atestados;
create policy "atestados_select_authenticated"
on public.atestados
for select
to authenticated
using (true);

drop policy if exists "sincronizacoes_select_authenticated" on public.sincronizacoes;
create policy "sincronizacoes_select_authenticated"
on public.sincronizacoes
for select
to authenticated
using (true);
