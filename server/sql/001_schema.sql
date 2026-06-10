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
  ativo boolean not null default true,
  data_desligamento date,
  user_account_id_nexti bigint,
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
  tipo_ausencia_nome text,
  eh_atestado_medico boolean not null default false,
  removido boolean not null default false,
  lancado_por_id bigint,
  lancado_por_nome text,
  medico text,
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

create index if not exists idx_colaboradores_ativo on public.colaboradores (ativo);
create index if not exists idx_colaboradores_user_account_id_nexti on public.colaboradores (user_account_id_nexti);
create index if not exists idx_atestados_periodo on public.atestados (data_inicio, data_fim);
create index if not exists idx_atestados_person_id_nexti on public.atestados (person_id_nexti);
create index if not exists idx_atestados_status_periodo on public.atestados (removido, data_inicio, data_fim);
create index if not exists idx_atestados_medicos_periodo
  on public.atestados (eh_atestado_medico, removido, data_inicio, data_fim);
create index if not exists idx_atestados_lancado_por_id
  on public.atestados (lancado_por_id)
  where lancado_por_id is not null;
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
