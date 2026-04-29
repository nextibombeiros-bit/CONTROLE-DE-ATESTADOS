# Controle de Atestados

Aplicacao para acompanhar colaboradores com 16 dias ou mais de atestados medicos dentro de um periodo movel, usando React/Vite, Supabase e sincronizacao com a API Nexti via Supabase Edge Function.

O sistema agora considera apenas atestados medicos, exclui colaboradores desligados do painel e mantem o frontend em atualizacao automatica com sincronizacao recorrente no Supabase.

## Escopo Nexti

Este sistema e apenas de consulta e controle. A integracao com a Nexti nao cria, altera nem exclui lancamentos na Nexti.

A Edge Function usa `POST` somente para obter token OAuth em `/security/oauth/token`, com `Authorization: Basic` e `grant_type=client_credentials`. Depois disso, a Nexti e acessada apenas por consultas `GET` nos endpoints permitidos:

- `/absences/lastupdate/start/{start}/finish/{finish}`
- `/absencesituations/all`
- `/persons/{id}`
- `/persons/all`
- `/useraccounts/startdate/{startDate}/finishdate/{finishDate}`

Qualquer outro caminho da API Nexti e bloqueado pela propria funcao.

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
2. Aplique todas as migrations da pasta `supabase/migrations/` no projeto.
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

Se esses filtros ficarem vazios, a funcao tentara identificar automaticamente apenas as situacoes medicas pela configuracao da propria Nexti.

O comportamento recomendado e deixar a funcao identificar automaticamente situacoes medicas pela propria configuracao da Nexti (`cid`, `medicalDoctor` e nome da situacao). Se o seu ambiente usar nomes ou flags fora do padrao, preencha os filtros acima para forcar somente os IDs corretos.

Voce tambem pode ajustar a janela automatica:

```bash
supabase secrets set NEXTI_SYNC_INITIAL_LOOKBACK_DAYS="365"
supabase secrets set NEXTI_SYNC_OVERLAP_MINUTES="15"
```

- `NEXTI_SYNC_INITIAL_LOOKBACK_DAYS`: periodo usado na primeira sincronizacao automatica, quando ainda nao existe historico de execucao.
- `NEXTI_SYNC_OVERLAP_MINUTES`: folga de seguranca para nao perder atualizacoes entre uma execucao e outra.

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
npm ci
npm run dev
```

O arquivo `.env` e opcional neste projeto. Se ele nao existir, o frontend usa o fallback publico ja configurado em `src/lib/supabase.ts`. So crie `.env` se quiser apontar para outro projeto Supabase.

As CLIs necessarias ficam instaladas no proprio projeto. Use os scripts abaixo:

```bash
npm run supabase -- --version
npm run deno:check
npm run supabase:login
npm run supabase:link
npm run supabase:db:push
npm run supabase:functions:deploy
```

Depois de aplicar as migrations e publicar a function, a sincronizacao passa a rodar automaticamente a cada 5 minutos via `pg_cron` + `pg_net` no proprio Supabase.

## Operacao local no Windows (PowerShell)

Se voce quiser operar este repositorio diretamente do Windows, sem depender do Codespaces:

1. Abra PowerShell na raiz do projeto.
2. Rode o setup local:

```powershell
.\scripts\setup_local.ps1
```

Esse script:

- garante que `origin` aponta para o repositorio certo;
- configura o Git Credential Manager do Windows;
- instala as dependencias do projeto com `npm ci`.

Depois disso, o fluxo diario fica:

```powershell
git pull
npm run dev
git status
.\scripts\connect_git_and_push.ps1 -CommitMessage "ajuste no dashboard"
```

Na primeira autenticacao com o GitHub, use o login do navegador ou um PAT valido quando o Git pedir credenciais. Evite gravar token fixo no `origin`.

## Operacao no Codespaces ou Linux

Para manter o mesmo fluxo em shell Unix, o repositorio agora inclui:

```bash
chmod +x scripts/connect_git_and_push.sh
./scripts/connect_git_and_push.sh
```

Se quiser forcar push com token temporario no ambiente, exporte:

```bash
export GITHUB_REPO_URL="https://github.com/nextibombeiros-bit/CONTROLE-DE-ATESTADOS.git"
export GITHUB_USERNAME="nextibombeiros-bit"
export GITHUB_TOKEN="SEU_PAT_VALIDO"
./scripts/connect_git_and_push.sh
```

## Publicacao no GitHub Pages

No repositorio GitHub, configure os secrets:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

O app tambem tem fallback para a URL do projeto e para a chave publishable publica do Supabase, porque esse valor fica exposto no frontend de qualquer forma. Os secrets acima continuam recomendados se voce quiser trocar a chave sem alterar codigo.

Depois ative Pages usando GitHub Actions. O workflow gera o build com base `/CONTROLE-DE-ATESTADOS/`.

## Como usar

1. Acesse o site.
2. Escolha o periodo: 30, 60, 90 dias ou intervalo manual.
3. Aguarde a sincronizacao automatica da Nexti. Nao e necessario clicar em botao manual.
4. A tabela mostra uma linha por colaborador, ordenada pelo maior total de dias distintos no periodo.
5. Clique no nome do colaborador para abrir o historico detalhado de cada atestado.

O acesso ao dashboard esta sem login. As policies do Supabase permitem leitura publica das tabelas usadas pela tela.

## Regras de status

- `ALERTA AFASTAMENTO`: 16 dias ou mais.
- `PROXIMO DO LIMITE`: 12 a 15 dias.
- `ATENCAO`: 8 a 11 dias.
- `OK`: menos de 8 dias.

O calculo considera apenas os dias do atestado que caem dentro do periodo selecionado.
