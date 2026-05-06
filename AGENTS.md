# Guia Para Codex e VSCode

## Ambiente
- Use Node 22 e rode `npm ci` antes de desenvolver.
- No Codespaces, o devcontainer instala dependencias automaticamente.
- O projeto Supabase oficial e `wzimpnedfceadlgolrqw`.

## Comandos
- `npm run dev`: abre o Vite.
- `npm run lint`: valida TypeScript do frontend.
- `npm run build`: gera o build do GitHub Pages.
- `npm run deno:check`: valida a Edge Function.
- `npm run supabase:link:project`: linka a CLI ao projeto Supabase oficial.
- `npm run supabase:db:push`: aplica migrations pendentes.
- `npm run supabase:functions:deploy`: publica `sync-nexti`.

## Segredos
- Nunca commite `.env`, PAT do GitHub, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY` ou credenciais Nexti.
- Em maquinas temporarias, prefira login interativo: `npm run supabase:login` e autenticacao GitHub pelo navegador.
- Se precisar usar PAT em terminal, exporte somente na sessao atual e apague o terminal depois.
