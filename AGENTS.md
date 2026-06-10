# Guia Para Codex e VSCode

## Ambiente
- Use Node 22 e rode `npm ci` antes de desenvolver.
- O projeto nao usa mais Supabase. A stack atual e React/Vite + Node/Express + PostgreSQL.
- O deploy de producao fica no Hostinger KVM via Docker Compose.

## Comandos
- `npm run dev`: abre somente o frontend Vite.
- `npm run dev:server`: sobe o backend Node localmente.
- `npm run lint`: valida TypeScript do frontend e backend.
- `npm run test`: roda os testes de regra de negocio.
- `npm run build`: gera `dist/` do frontend e `dist-server/` do backend.
- `npm start`: inicia o backend compilado, servindo tambem o frontend de `dist/`.

## Segredos
- Nunca commite `.env`, `.env.hostinger`, credenciais Nexti, senha do PostgreSQL, PAT do GitHub ou chaves SSH.
- Use `.env.example` e `.env.hostinger.example` apenas como modelo.
- As credenciais Nexti devem existir somente no ambiente do backend no VPS.
