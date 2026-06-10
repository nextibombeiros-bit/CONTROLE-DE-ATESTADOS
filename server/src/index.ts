import "dotenv/config";
import cors from "cors";
import express from "express";
import path from "node:path";
import { createDb, runMigrations } from "./db.js";
import { runNextiSync, type SyncRequestBody, type SyncResult } from "./nexti-sync.js";

type EventClient = {
  id: number;
  write: (event: string, payload: unknown) => void;
  close: () => void;
};

const port = Number(process.env.PORT ?? 3000);
const syncPollSeconds = Math.max(15, Number(process.env.NEXTI_SYNC_POLL_SECONDS ?? 60));
const autoSyncEnabled = process.env.NEXTI_AUTO_SYNC_ENABLED !== "false";
const app = express();
const db = createDb();
const eventClients = new Map<number, EventClient>();
let nextClientId = 1;
let syncTimer: NodeJS.Timeout | null = null;

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(cors({
  origin: process.env.APP_PUBLIC_ORIGIN ? process.env.APP_PUBLIC_ORIGIN.split(",").map((item) => item.trim()) : true,
}));

app.get("/health", async (_request, response) => {
  try {
    await db.query("select 1 as ok");
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/atestados", async (_request, response) => {
  try {
    const rows = await db.query(`
      select
        a.id,
        a.id_nexti,
        a.person_id_nexti,
        a.matricula,
        a.data_inicio,
        a.data_fim,
        a.dias,
        a.data_lancamento,
        a.lancado_por,
        a.cid,
        a.observacao,
        a.tipo_ausencia_id,
        a.tipo_ausencia_external_id,
        a.tipo_ausencia_nome,
        a.eh_atestado_medico,
        a.removido,
        a.lancado_por_id,
        a.lancado_por_nome,
        a.medico,
        row_to_json(c.*) as colaboradores
      from public.atestados a
      inner join public.colaboradores c on c.person_id_nexti = a.person_id_nexti
      where a.removido = false
        and a.eh_atestado_medico = true
        and c.ativo = true
        and c.data_desligamento is null
      order by a.data_inicio desc, a.id_nexti desc
    `);

    response.json(rows);
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/sincronizacoes/latest", async (_request, response) => {
  const { data, error } = await db
    .from("sincronizacoes")
    .select("*")
    .order("iniciado_em", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    response.status(500).json({ error: error.message });
    return;
  }

  response.json(data);
});

app.post("/api/sync-nexti", async (request, response) => {
  const result = await syncNexti(request.body as SyncRequestBody, "manual");
  response.status(result.status).json(result.payload);
});

app.get("/api/events", (request, response) => {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders?.();

  const clientId = nextClientId++;
  const client: EventClient = {
    id: clientId,
    write(event, payload) {
      response.write(`event: ${event}\n`);
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
    },
    close() {
      response.end();
    },
  };

  eventClients.set(clientId, client);
  client.write("ready", { ok: true });

  request.on("close", () => {
    eventClients.delete(clientId);
  });
});

const distPath = path.join(process.cwd(), "dist");
app.use(express.static(distPath));
app.get(/.*/, (_request, response) => {
  response.sendFile(path.join(distPath, "index.html"));
});

await runMigrations(db);

app.listen(port, () => {
  console.log(`Controle de Atestados rodando na porta ${port}`);
});

if (autoSyncEnabled) {
  syncTimer = setInterval(() => {
    void syncNexti({ automatic: true }, "auto-timer");
  }, syncPollSeconds * 1000);
  syncTimer.unref?.();
  void syncNexti({ automatic: true }, "startup");
}

process.on("SIGTERM", () => {
  if (syncTimer) clearInterval(syncTimer);
  for (const client of eventClients.values()) client.close();
  void db.close().finally(() => process.exit(0));
});

async function syncNexti(body: SyncRequestBody, source: string): Promise<{ status: number; payload: SyncResult }> {
  const result = await runNextiSync(db, body, { source }).catch((error) => ({
    status: 500,
    payload: { error: error instanceof Error ? error.message : String(error) },
  }));

  if (result.status < 400) {
    broadcast("sync", result.payload);
  }

  return result;
}

function broadcast(event: string, payload: unknown) {
  for (const client of eventClients.values()) {
    client.write(event, payload);
  }
}
