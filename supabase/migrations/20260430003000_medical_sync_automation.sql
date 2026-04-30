create extension if not exists pg_net;
create extension if not exists pg_cron;

alter table public.colaboradores
  add column if not exists ativo boolean not null default true,
  add column if not exists data_desligamento date,
  add column if not exists user_account_id_nexti bigint;

alter table public.atestados
  add column if not exists tipo_ausencia_nome text,
  add column if not exists eh_atestado_medico boolean not null default false,
  add column if not exists lancado_por_id bigint,
  add column if not exists lancado_por_nome text,
  add column if not exists medico text;

update public.colaboradores
set
  ativo = case
    when coalesce(raw_json->>'personSituationId', '') = '3' then false
    else true
  end,
  data_desligamento = case
    when coalesce(raw_json->>'demissionDate', '') ~ '^[0-9]{14}$'
      then to_timestamp(raw_json->>'demissionDate', 'DDMMYYYYHH24MISS')::date
    else data_desligamento
  end,
  user_account_id_nexti = case
    when coalesce(raw_json->>'userAccountId', '') ~ '^[0-9]+$'
      then (raw_json->>'userAccountId')::bigint
    else user_account_id_nexti
  end
where raw_json <> '{}'::jsonb;

update public.atestados
set
  lancado_por_id = case
    when coalesce(raw_json->>'userRegisterId', '') ~ '^[0-9]+$'
      then (raw_json->>'userRegisterId')::bigint
    else lancado_por_id
  end,
  medico = nullif(
    trim(
      both ' / ' from concat_ws(
        ' / ',
        nullif(raw_json->>'medicalDoctorName', ''),
        nullif(raw_json->>'medicalDoctorCrm', '')
      )
    ),
    ''
  ),
  eh_atestado_medico = case
    when coalesce(raw_json->>'cidCode', '') <> '' then true
    when coalesce(raw_json->>'medicalDoctorName', '') <> '' then true
    when coalesce(raw_json->>'medicalDoctorCrm', '') <> '' then true
    else eh_atestado_medico
  end
where raw_json <> '{}'::jsonb;

create index if not exists idx_colaboradores_ativo on public.colaboradores (ativo);
create index if not exists idx_colaboradores_user_account_id_nexti on public.colaboradores (user_account_id_nexti);
create index if not exists idx_atestados_medicos_periodo
  on public.atestados (eh_atestado_medico, removido, data_inicio, data_fim);
create index if not exists idx_atestados_lancado_por_id
  on public.atestados (lancado_por_id)
  where lancado_por_id is not null;

do $$
begin
  alter publication supabase_realtime add table public.colaboradores;
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  alter publication supabase_realtime add table public.atestados;
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  alter publication supabase_realtime add table public.sincronizacoes;
exception
  when duplicate_object then null;
end
$$;

create or replace function public.configure_sync_nexti_automation(
  project_url text default 'https://wzimpnedfceadlgolrqw.supabase.co',
  cron_expression text default '*/5 * * * *'
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  existing_job_id bigint;
begin
  if coalesce(trim(project_url), '') = '' then
    raise exception 'project_url obrigatoria';
  end if;

  select jobid
    into existing_job_id
  from cron.job
  where jobname = 'sync-nexti-auto';

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  perform cron.schedule(
    'sync-nexti-auto',
    cron_expression,
    format(
      $job$
      select net.http_post(
        url:=%L || '/functions/v1/sync-nexti',
        headers:=jsonb_build_object(
          'Content-Type', 'application/json',
          'X-Sync-Source', 'supabase-cron'
        ),
        body:='{"automatic": true}'::jsonb
      ) as request_id;
      $job$,
      project_url
    )
  );
end;
$function$;

create or replace function public.disable_sync_nexti_automation()
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  existing_job_id bigint;
begin
  select jobid
    into existing_job_id
  from cron.job
  where jobname = 'sync-nexti-auto';

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;
end;
$function$;

revoke all on function public.configure_sync_nexti_automation(text, text) from public;
revoke all on function public.disable_sync_nexti_automation() from public;
grant execute on function public.configure_sync_nexti_automation(text, text) to postgres, service_role;
grant execute on function public.disable_sync_nexti_automation() to postgres, service_role;

select public.configure_sync_nexti_automation();
