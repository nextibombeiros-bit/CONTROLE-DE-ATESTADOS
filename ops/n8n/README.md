# n8n - Alertas de Atestados

O n8n roda no mesmo Docker Compose do app e fica em:

- Temporario Hostinger: `https://srv1715480.hstgr.cloud/n8n/`
- Futuro dominio proprio: `https://SEU_DOMINIO/n8n/`

O webhook esperado pelo backend e:

```text
https://srv1715480.hstgr.cloud/n8n/webhook/controle-atestados
```

Mantenha `N8N_WEBHOOK_URL` vazio no `.env` enquanto o workflow nao estiver ativo. Depois de ativar, configure essa URL e reinicie o container `app`.

## Primeiro Acesso

1. Acesse `/n8n/` e crie o usuario dono.
2. Crie a credencial de e-mail com `Send Email` usando SMTP Gmail/Workspace:
   - Host: `smtp.gmail.com`
   - Port: `465`
   - SSL/TLS: ligado
   - User: conta Gmail/Workspace
   - Password: senha de app do Gmail/Workspace
3. Nao use a senha normal da conta Google. Gere uma senha de app em uma conta com 2FA ativo.

## Data Tables

Crie a Data Table `destinatarios_atestados`:

| Campo | Tipo | Exemplo |
| --- | --- | --- |
| `email` | Text | `rh@empresa.com.br` |
| `empresas` | Text | `Dunamis Bombeiros,Dunamis Serviços` |
| `ativo` | Boolean | `true` |

Use `Todas` ou deixe `empresas` vazio para receber eventos de todas as empresas.

Crie a Data Table `modelos_email`:

| Campo | Tipo | Exemplo |
| --- | --- | --- |
| `tipo_evento` | Text | `novo_atestado` |
| `assunto` | Text | `Novo atestado: {{employee.name}}` |
| `html` | Text | HTML do e-mail |
| `texto` | Text | Texto simples |
| `ativo` | Boolean | `true` |

Crie modelos ativos para:

- `novo_atestado`
- `mudanca_nivel_alerta`

## Workflow

Fluxo recomendado:

1. `Webhook`
   - Method: `POST`
   - Path: `controle-atestados`
   - Authentication: `None`
   - Response mode: `Using Respond to Webhook node`
2. `Code - Validar segredo`
3. `Data Table - destinatarios_atestados`
4. `Data Table - modelos_email`
5. `Code - Filtrar destinatarios e renderizar modelo`
6. `Send Email`
7. `Respond to Webhook`

Codigo sugerido para o node `Code - Validar segredo`:

O Docker Compose ja define `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` e passa `CONTROLE_WEBHOOK_SECRET` para o n8n, permitindo esta validacao sem gravar o segredo dentro do workflow.

```js
const expected = $env.CONTROLE_WEBHOOK_SECRET;
const headers = $json.headers ?? {};
const received = headers["x-controle-secret"] ?? headers["X-Controle-Secret"];

if (!expected || received !== expected) {
  throw new Error("Webhook nao autorizado");
}

return [{ json: $json.body }];
```

Codigo base para filtrar empresas no node de renderizacao:

```js
const payload = $("Code - Validar segredo").first().json;
const company = payload.company ?? payload.employee?.empresa ?? "";
const recipients = $("Data Table - destinatarios_atestados").all()
  .map((item) => item.json)
  .filter((row) => row.ativo !== false)
  .filter((row) => {
    const raw = String(row.empresas ?? "").trim();
    if (!raw || raw.toLowerCase() === "todas") return true;
    return raw.split(",").map((value) => value.trim()).includes(company);
  });

const model = $("Data Table - modelos_email").all()
  .map((item) => item.json)
  .find((row) => row.ativo !== false && row.tipo_evento === payload.eventType);

if (!model) {
  throw new Error(`Modelo ativo nao encontrado para ${payload.eventType}`);
}

function get(path) {
  return path.split(".").reduce((value, key) => value?.[key], payload);
}

function render(template) {
  return String(template ?? "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const value = get(path);
    return value == null ? "" : String(value);
  });
}

return recipients.map((recipient) => ({
  json: {
    to: recipient.email,
    subject: render(model.assunto),
    html: render(model.html),
    text: render(model.texto),
    eventKey: payload.eventKey,
  },
}));
```

No node `Send Email`, use os campos:

- To: `{{$json.to}}`
- Subject: `{{$json.subject}}`
- HTML: `{{$json.html}}`
- Text: `{{$json.text}}`

No node `Respond to Webhook`, responda:

```json
{ "ok": true }
```

## Empresas

Empresas previstas para o filtro:

- `Dunamis Bombeiros`
- `Dunamis Serviços`
- `Dunamis Segurança`
- `RB Facilities`
- `Acaz`

## Payload Recebido

O backend envia:

```json
{
  "eventType": "novo_atestado",
  "eventKey": "novo_atestado:123",
  "company": "Dunamis Bombeiros",
  "employee": {
    "personId": 123,
    "name": "NOME",
    "matricula": "0001",
    "cargo": "CONTROLADOR",
    "unidade": "POSTO",
    "empresa": "Dunamis Bombeiros"
  },
  "absence": {
    "idNexti": 123,
    "startDate": "2026-06-01",
    "endDate": "2026-06-02",
    "days": 2,
    "launchedAt": "2026-06-02T10:00:00.000Z",
    "launchedBy": "OPERADOR",
    "cid": "A00",
    "medico": "DR. EXEMPLO",
    "observacao": "Texto livre",
    "tipo": "ATESTADO"
  },
  "alert": {
    "level": "atencao",
    "label": "ATENCAO",
    "previousLevel": "ok",
    "previousLabel": "OK",
    "totalDias": 8,
    "threshold": 8,
    "windowStart": "2026-04-12",
    "windowEnd": "2026-06-10"
  },
  "siteUrl": "https://nextibombeiros-bit.github.io/CONTROLE-DE-ATESTADOS/",
  "createdAt": "2026-06-10T12:00:00.000Z"
}
```

## Modelo HTML Inicial

```html
<p><strong>{{employee.name}}</strong> teve um novo evento de atestado.</p>
<p>
  Empresa: {{company}}<br>
  Unidade: {{employee.unidade}}<br>
  Periodo: {{absence.startDate}} a {{absence.endDate}}<br>
  Dias: {{absence.days}}<br>
  Nivel atual: {{alert.label}}<br>
  Nivel anterior: {{alert.previousLabel}}
</p>
<p><a href="{{siteUrl}}">Abrir Controle de Atestados</a></p>
```
