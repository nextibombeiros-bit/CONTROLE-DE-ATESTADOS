drop policy if exists "colaboradores_select_public" on public.colaboradores;
create policy "colaboradores_select_public"
on public.colaboradores
for select
to anon, authenticated
using (true);

drop policy if exists "atestados_select_public" on public.atestados;
create policy "atestados_select_public"
on public.atestados
for select
to anon, authenticated
using (true);

drop policy if exists "sincronizacoes_select_public" on public.sincronizacoes;
create policy "sincronizacoes_select_public"
on public.sincronizacoes
for select
to anon, authenticated
using (true);
