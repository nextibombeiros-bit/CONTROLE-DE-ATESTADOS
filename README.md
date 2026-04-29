# Controle de Atestados

Aplicacao para acompanhar colaboradores com 16 dias ou mais de atestados medicos dentro de um periodo movel, usando React/Vite, Supabase e sincronizacao com a API Nexti via Supabase Edge Function.

## Seguranca

Os segredos da Nexti e a `service_role` do Supabase devem ficar somente nas variaveis da Edge Function. Nao coloque esses valores no frontend, no GitHub Pages, no README ou em commits.

O arquivo local `prompt controle de atestados` foi colocado no `.gitignore` porque contem credenciais em texto puro. Recomenda-se revogar e recriar qualquer token que tenha sido colado em arquivo local, chat ou terminal.

## Estrutura

- `src/`: dashboard React.
- `supabase/migrations/`: tabelas `colaboradores`, `atestados` e `sincronizacoes`.
- `supabase/functions/sync-nexti/`: Edge Function que autentica na Nexti, busca ausencias por `lastUpdate`, busca colaboradores e salva no Supabase.
- `.github/workflows/deploy-pages.yml`: publicacao no GitHub Pages.

## Configuracao do Supabase

1. Crie ou abra o projeto no Supabase.
2. Rode o SQL de `supabase/migrations/20260429180000_init.sql` no SQL Editor.
3. Publique a Edge Function:

```bash
supabase functions deploy sync-nexti
```

4. Configure os segredos da Edge Function:

```bash
supabase secrets set NEXTI_CLIENT_ID="seu_client_id"
supabase secrets set NEXTI_CLIENT_SECRET="seu_client_secret"
supabase secrets set NEXTI_API_BASE_URL="https://api.nexti.com"
supabase secrets set NEXTI_TOKEN_URL="https://api.nexti.com/security/oauth/token"
```

Para importar somente atestados medicos, informe os IDs de situacao de ausencia usados na Nexti:

```bash
supabase secrets set NEXTI_MEDICAL_ABSENCE_SITUATION_IDS="1,2,3"
```

Ou, se a sua Nexti usa IDs externos:

```bash
supabase secrets set NEXTI_MEDICAL_ABSENCE_SITUATION_EXTERNAL_IDS="ATESTADO_MEDICO"
```

Se esses filtros ficarem vazios, a sincronizacao importara todas as ausencias retornadas pela Nexti.

## Configuracao do frontend

Crie `.env` a partir de `.env.example`:

```bash
cp .env.example .env
```

Preencha:

```bash
VITE_SUPABASE_URL=https://SEU_PROJECT_ID.supabase.co
VITE_SUPABASE_ANON_KEY=sua_chave_anon_publica
```

Rode localmente:

```bash
npm install
npm run dev
```

As CLIs necessarias ficam instaladas no proprio projeto. Use os scripts abaixo:

```bash
npm run supabase -- --version
npm run deno:check
npm run supabase:login
npm run supabase:link
npm run supabase:db:push
npm run supabase:functions:deploy
```

## Publicacao no GitHub Pages

No repositorio GitHub, configure os secrets:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

O app tambem tem fallback para a URL do projeto e para a chave publishable publica do Supabase, porque esse valor fica exposto no frontend de qualquer forma. Os secrets acima continuam recomendados se voce quiser trocar a chave sem alterar codigo.

Depois ative Pages usando GitHub Actions. O workflow gera o build com base `/CONTROLE-DE-ATESTADOS/`.

## Como usar

1. Acesse o site.
2. Informe o email para receber o link de acesso do Supabase Auth.
3. Escolha o periodo: 30, 60, 90 dias ou intervalo manual.
4. Clique em sincronizar para buscar dados da Nexti por `lastUpdate`.
5. A tabela mostra uma linha por colaborador, ordenada pelo maior total de dias.

## Regras de status

- `ALERTA AFASTAMENTO`: 16 dias ou mais.
- `PROXIMO DO LIMITE`: 12 a 15 dias.
- `ATENCAO`: 8 a 11 dias.
- `OK`: menos de 8 dias.

O calculo considera apenas os dias do atestado que caem dentro do periodo selecionado.
