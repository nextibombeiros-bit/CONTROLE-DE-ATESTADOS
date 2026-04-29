import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

type SupabaseAdmin = ReturnType<typeof createClient<any, "public", any>>;

type NextiAbsence = {
  id?: number;
  personId?: number;
  personExternalId?: string;
  absenceSituationId?: number;
  absenceSituationExternalId?: string;
  finishDateTime?: string;
  startDateTime?: string;
  note?: string;
  lastUpdate?: string;
  removed?: boolean;
  cidCode?: string;
  cidDescription?: string;
  userRegisterId?: number;
  [key: string]: unknown;
};

type NextiPerson = {
  id?: number;
  enrolment?: string;
  name?: string;
  nameCareer?: string;
  workplaceName?: string;
  companyId?: number;
  externalCompanyId?: string;
  businessUnitName?: string;
  personSituationId?: number;
  lastUpdate?: string;
  [key: string]: unknown;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DAY_MS = 24 * 60 * 60 * 1000;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Metodo nao permitido" }, 405);
  }

  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const nextiClientId = requireEnv("NEXTI_CLIENT_ID");
  const nextiClientSecret = requireEnv("NEXTI_CLIENT_SECRET");
  const nextiBaseUrl = Deno.env.get("NEXTI_API_BASE_URL") ?? "https://api.nexti.com";
  const nextiTokenUrl = Deno.env.get("NEXTI_TOKEN_URL") ?? "https://api.nexti.com/security/oauth/token";

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const authHeader = request.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  const { data: userData, error: userError } = await admin.auth.getUser(jwt);
  if (userError || !userData.user) {
    return json({ error: "Sessao invalida" }, 401);
  }

  const body = await safeJson(request);
  const now = new Date();
  const defaultStart = new Date(now.getTime() - 30 * DAY_MS);
  const start = parseInputDate(body.startLastUpdate) ?? defaultStart;
  const finish = parseInputDate(body.finishLastUpdate) ?? now;
  const pageSize = Number(body.pageSize ?? 100);
  const filters = readMedicalFilters();

  const { data: log, error: logError } = await admin
    .from("sincronizacoes")
    .insert({
      status: "em_execucao",
      periodo_inicio: start.toISOString(),
      periodo_fim: finish.toISOString(),
    })
    .select("id")
    .single();

  if (logError) {
    return json({ error: logError.message }, 500);
  }

  try {
    const token = await getNextiToken(nextiTokenUrl, nextiClientId, nextiClientSecret);
    const personCache = new Map<number, NextiPerson | null>();
    let imported = 0;
    let updated = 0;
    let skippedByFilter = 0;

    for (const chunk of splitIntoChunks(start, finish, 31)) {
      let page = 0;
      let totalPages = 1;

      while (page < totalPages) {
        const path = `/absences/lastupdate/start/${formatNextiDate(chunk.start)}/finish/${formatNextiDate(chunk.finish)}`;
        const payload = await fetchNexti(nextiBaseUrl, path, token, { page: String(page), size: String(pageSize) });
        const absences = extractContent<NextiAbsence>(payload);
        totalPages = Number(payload.totalPages ?? payload.value?.totalPages ?? 1);

        for (const absence of absences) {
          if (!absence.id || !absence.personId || !absence.startDateTime) continue;
          if (!matchesMedicalFilter(absence, filters)) {
            skippedByFilter += 1;
            continue;
          }

          let person = personCache.get(absence.personId);
          if (person === undefined) {
            person = await fetchPerson(nextiBaseUrl, token, absence.personId);
            personCache.set(absence.personId, person);
          }

          await upsertPerson(admin, absence, person);
          const upsertResult = await upsertAbsence(admin, absence, person);
          if (upsertResult === "created") imported += 1;
          if (upsertResult === "updated") updated += 1;
        }

        page += 1;
      }
    }

    await admin
      .from("sincronizacoes")
      .update({
        status: "sucesso",
        finalizado_em: new Date().toISOString(),
        quantidade_importada: imported,
        quantidade_atualizada: updated,
        detalhes: {
          skippedByFilter,
          filterEnabled: filters.ids.size > 0 || filters.externalIds.size > 0,
        },
      })
      .eq("id", log.id);

    return json({ imported, updated, skippedByFilter });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    await admin
      .from("sincronizacoes")
      .update({
        status: "erro",
        finalizado_em: new Date().toISOString(),
        erro: message,
      })
      .eq("id", log.id);

    return json({ error: message }, 500);
  }
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Variavel ${name} nao configurada`);
  return value;
}

async function safeJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseInputDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatNextiDate(date: Date): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${day}${month}${year}${hours}${minutes}${seconds}`;
}

function parseNextiDate(value?: string): Date | null {
  if (!value || !/^\d{14}$/.test(value)) return null;
  const day = Number(value.slice(0, 2));
  const month = Number(value.slice(2, 4)) - 1;
  const year = Number(value.slice(4, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  return new Date(Date.UTC(year, month, day, hour, minute, second));
}

function toDateOnly(value?: string): string | null {
  const parsed = parseNextiDate(value);
  return parsed ? parsed.toISOString().slice(0, 10) : null;
}

function toTimestamp(value?: string): string | null {
  const parsed = parseNextiDate(value);
  return parsed ? parsed.toISOString() : null;
}

function inclusiveDays(start: string, finish?: string): number {
  const startDate = parseNextiDate(start);
  const finishDate = parseNextiDate(finish ?? start);
  if (!startDate || !finishDate) return 1;
  return Math.max(1, Math.floor((finishDate.getTime() - startDate.getTime()) / DAY_MS) + 1);
}

function splitIntoChunks(start: Date, finish: Date, maxDays: number): Array<{ start: Date; finish: Date }> {
  const chunks: Array<{ start: Date; finish: Date }> = [];
  let cursor = new Date(start);

  while (cursor <= finish) {
    const chunkFinish = new Date(Math.min(finish.getTime(), cursor.getTime() + (maxDays - 1) * DAY_MS));
    chunks.push({ start: new Date(cursor), finish: chunkFinish });
    cursor = new Date(chunkFinish.getTime() + 1000);
  }

  return chunks;
}

async function getNextiToken(tokenUrl: string, clientId: string, clientSecret: string): Promise<string> {
  const url = new URL(tokenUrl);
  url.searchParams.set("grant_type", "client_credentials");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("client_secret", clientSecret);

  const response = await fetch(url, { method: "POST" });
  if (!response.ok) {
    throw new Error(`Falha ao autenticar na Nexti: ${response.status}`);
  }

  const payload = await response.json();
  if (!payload.access_token) {
    throw new Error("Resposta de token da Nexti sem access_token");
  }

  return payload.access_token as string;
}

async function fetchNexti(
  baseUrl: string,
  path: string,
  token: string,
  query?: Record<string, string>,
): Promise<Record<string, any>> {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Nexti ${path} retornou ${response.status}: ${text.slice(0, 240)}`);
  }

  return await response.json();
}

function extractContent<T>(payload: Record<string, any>): T[] {
  if (Array.isArray(payload.content)) return payload.content as T[];
  if (Array.isArray(payload.value?.content)) return payload.value.content as T[];
  if (Array.isArray(payload.value)) return payload.value as T[];
  return [];
}

async function fetchPerson(baseUrl: string, token: string, personId: number): Promise<NextiPerson | null> {
  const payload = await fetchNexti(baseUrl, `/persons/${personId}`, token);
  return (payload.value ?? payload) as NextiPerson;
}

async function upsertPerson(admin: SupabaseAdmin, absence: NextiAbsence, person: NextiPerson | null) {
  const personId = absence.personId!;
  const situation = person?.personSituationId ? situationLabel(person.personSituationId) : null;

  const { error } = await admin.from("colaboradores").upsert(
    {
      person_id_nexti: personId,
      matricula: person?.enrolment ?? null,
      nome: person?.name ?? `Colaborador ${personId}`,
      cargo: person?.nameCareer ?? null,
      posto: person?.workplaceName ?? person?.businessUnitName ?? null,
      empresa: person?.externalCompanyId ?? (person?.companyId ? String(person.companyId) : null),
      situacao: situation,
      ultima_atualizacao: toTimestamp(person?.lastUpdate) ?? toTimestamp(absence.lastUpdate),
      raw_json: person ?? { id: personId },
    },
    { onConflict: "person_id_nexti" },
  );

  if (error) throw new Error(`Erro ao salvar colaborador ${personId}: ${error.message}`);
}

async function upsertAbsence(
  admin: SupabaseAdmin,
  absence: NextiAbsence,
  person: NextiPerson | null,
): Promise<"created" | "updated"> {
  if (!absence.id || !absence.personId) return "updated";

  const absenceId = absence.id;
  const personId = absence.personId;
  const start = toDateOnly(absence.startDateTime);
  const finish = toDateOnly(absence.finishDateTime ?? absence.startDateTime);
  if (!start || !finish) return "updated";

  const { data: existing } = await admin
    .from("atestados")
    .select("id")
    .eq("id_nexti", absenceId)
    .maybeSingle();

  const cid = [absence.cidCode, absence.cidDescription].filter(Boolean).join(" - ") || null;
  const { error } = await admin.from("atestados").upsert(
    {
      id_nexti: absence.id,
      person_id_nexti: personId,
      matricula: person?.enrolment ?? null,
      data_inicio: start,
      data_fim: finish,
      dias: inclusiveDays(absence.startDateTime!, absence.finishDateTime),
      data_lancamento: toTimestamp(absence.lastUpdate),
      lancado_por: absence.userRegisterId ? String(absence.userRegisterId) : null,
      cid,
      observacao: absence.note ?? null,
      tipo_ausencia_id: absence.absenceSituationId ?? null,
      tipo_ausencia_external_id: absence.absenceSituationExternalId ?? null,
      removido: Boolean(absence.removed),
      raw_json: absence,
    },
    { onConflict: "id_nexti" },
  );

  if (error) throw new Error(`Erro ao salvar atestado ${absence.id}: ${error.message}`);
  return existing ? "updated" : "created";
}

function situationLabel(id: number): string {
  if (id === 1) return "TRABALHANDO";
  if (id === 2) return "AUSENTE";
  if (id === 3) return "DEMITIDO";
  return String(id);
}

function readMedicalFilters(): { ids: Set<number>; externalIds: Set<string> } {
  const ids = new Set(
    (Deno.env.get("NEXTI_MEDICAL_ABSENCE_SITUATION_IDS") ?? "")
      .split(",")
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isFinite(item)),
  );
  const externalIds = new Set(
    (Deno.env.get("NEXTI_MEDICAL_ABSENCE_SITUATION_EXTERNAL_IDS") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  return { ids, externalIds };
}

function matchesMedicalFilter(absence: NextiAbsence, filters: { ids: Set<number>; externalIds: Set<string> }): boolean {
  if (filters.ids.size === 0 && filters.externalIds.size === 0) return true;
  if (absence.absenceSituationId && filters.ids.has(absence.absenceSituationId)) return true;
  if (absence.absenceSituationExternalId && filters.externalIds.has(absence.absenceSituationExternalId)) return true;
  return false;
}
