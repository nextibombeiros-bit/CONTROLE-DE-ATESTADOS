# Controle de Atestados

Aplicacao para acompanhar colaboradores com 16 dias ou mais de atestados medicos dentro de uma janela movel, usando React/Vite, Node/Express, PostgreSQL e sincronizacao com a API Nexti.

O projeto foi removido do Supabase. A API, o sincronizador e o banco ficam no Hostinger KVM via Docker Compose. Enquanto o dominio publico continuar em GitHub Pages, o frontend publicado em `https://nextibombeiros-bit.github.io/CONTROLE-DE-ATESTADOS/` consome a API HTTPS do VPS.

## Arquitetura

- `src/`: dashboard React.
- `server/src/`: API Node, sincronizador Nexti e acesso PostgreSQL.
- `server/sql/001_schema.sql`: schema PostgreSQL das tabelas `colaboradores`, `atestados`, `sincronizacoes` e `notification_events`.
- `docker-compose.yml`: Postgres, aplicacao, n8n e labels para o Traefik da Hostinger.
- `ops/Caddyfile`: proxy HTTPS opcional para ambientes sem Traefik.
- `ops/n8n/README.md`: roteiro para criar Data Tables, modelos e workflow de e-mail no n8n.

## Variaveis

Crie `.env` para desenvolvimento local a partir de `.env.example`.

Para o VPS, copie `.env.hostinger.example` para `.env` no servidor e preencha:

- `APP_DOMAIN`: dominio apontado para o VPS, ex. `atestados.seudominio.com.br`.
- `APP_PUBLIC_ORIGIN`: origens permitidas pelo CORS, ex. `https://atestados.seudominio.com.br,https://nextibombeiros-bit.github.io`.
- `POSTGRES_PASSWORD`: senha forte do banco.
- `NEXTI_CLIENT_ID` e `NEXTI_CLIENT_SECRET`: credenciais da Nexti.
- `NEXTI_SYNC_POLL_SECONDS`: frequencia do polling automatico. O padrao e 60 segundos.
- `NEXTI_SYNC_INITIAL_LOOKBACK_DAYS`: janela da primeira importacao. Se a base antiga no Supabase estiver inacessivel, aumente para importar mais historico via Nexti.
- `NOTIFICATION_SITE_URL`: link publico usado nos e-mails. Hoje e `https://nextibombeiros-bit.github.io/CONTROLE-DE-ATESTADOS/`.
- `N8N_WEBHOOK_URL`: URL do webhook do workflow n8n. Deixe vazio ate o workflow estar ativo se nao quiser acumular tentativas com erro.
- `N8N_WEBHOOK_SECRET`: segredo enviado no header `X-Controle-Secret`.
- `N8N_ENCRYPTION_KEY`: chave fixa do n8n para criptografar credenciais.

## Desenvolvimento

```bash
npm ci
npm run lint
npm run test
npm run build
```

Para rodar localmente com backend, tenha um PostgreSQL disponivel e configure `DATABASE_URL`:

```bash
npm run dev:server
```

Em outro terminal:

```bash
npm run dev
```

## Deploy no Hostinger

No VPS Ubuntu com Docker:

```bash
git clone https://github.com/nextibombeiros-bit/CONTROLE-DE-ATESTADOS.git
cd CONTROLE-DE-ATESTADOS
cp .env.hostinger.example .env
nano .env
docker compose up -d --build
docker compose logs -f app
```

No VPS da Hostinger, o Traefik ja ocupa as portas `80` e `443`. O `docker-compose.yml` publica o app por labels do Traefik e usa o certificado HTTPS automatico dele. Em outros ambientes, o Caddy pode ser usado com `docker compose --profile caddy up -d`.

Com o dominio temporario da Hostinger, use:

```env
APP_DOMAIN=srv1715480.hstgr.cloud
APP_PUBLIC_ORIGIN=https://srv1715480.hstgr.cloud,https://nextibombeiros-bit.github.io
NOTIFICATION_SITE_URL=https://nextibombeiros-bit.github.io/CONTROLE-DE-ATESTADOS/
N8N_WEBHOOK_URL=https://srv1715480.hstgr.cloud/n8n/webhook/controle-atestados
```

O workflow de GitHub Pages builda o frontend com `VITE_API_BASE_URL=https://srv1715480.hstgr.cloud`.

## n8n e E-mails

O Docker Compose sobe o n8n em `https://SEU_DOMINIO/n8n/`. No dominio temporario da Hostinger, use `https://srv1715480.hstgr.cloud/n8n/`.

O backend cria eventos idempotentes na tabela `notification_events` para:

- `novo_atestado`: um evento por `id_nexti` de atestado novo.
- `mudanca_nivel_alerta`: um evento por colaborador e nivel cruzado (`ATENCAO`, `PROXIMO DO LIMITE`, `ALERTA AFASTAMENTO`).

Quando `N8N_WEBHOOK_URL` estiver configurada, o backend envia os eventos pendentes para o n8n e marca cada um como `enviado` ou `erro`. Eventos com erro ficam registrados e sao reenviados em novas sincronizacoes ate `NOTIFICATION_MAX_ATTEMPTS`.

Destinatarios e modelos nao ficam no site. Configure no n8n usando Data Tables conforme o roteiro em `ops/n8n/README.md`.

## Sincronizacao Nexti

O backend chama a Nexti automaticamente a cada `NEXTI_SYNC_POLL_SECONDS`. O navegador fica conectado em `/api/events` e recarrega os dados quando uma sincronizacao termina.

Tambem existe sincronizacao manual pelo botao "Sincronizar Nexti" no painel.

Para forcar uma carga historica pelo terminal:

```bash
curl -X POST "https://SEU_DOMINIO/api/sync-nexti" \
  -H "Content-Type: application/json" \
  -d '{"startLastUpdate":"2020-01-01T00:00:00.000Z","finishLastUpdate":"2026-06-09T23:59:59.000Z","pageSize":500}'
```

Se a conta Supabase estiver bloqueada e nao houver dump do banco antigo, a recuperacao historica depende dos dados que a API Nexti retornar no endpoint de `lastupdate`.

## Regras de Status

- `ALERTA AFASTAMENTO`: 16 dias ou mais.
- `PROXIMO DO LIMITE`: 12 a 15 dias.
- `ATENCAO`: 8 a 11 dias.
- `OK`: menos de 8 dias.

O calculo considera apenas os dias do atestado que caem dentro do periodo selecionado.
