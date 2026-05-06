do $$
begin
  if to_regprocedure('public.disable_sync_nexti_automation()') is not null then
    perform public.disable_sync_nexti_automation();
  end if;
end;
$$;

do $$
begin
  if exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'colaboradores'
  ) then
    alter publication supabase_realtime drop table public.colaboradores;
  end if;

  if exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'atestados'
  ) then
    alter publication supabase_realtime drop table public.atestados;
  end if;

  if exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'sincronizacoes'
  ) then
    alter publication supabase_realtime drop table public.sincronizacoes;
  end if;
end;
$$;
