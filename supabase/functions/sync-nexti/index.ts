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
const ALLOWED_NEXTI_READ_PATHS = ["/absences/lastupdate/", "/persons/", "/persons/all"];

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
    const absencesById = new Map<number, NextiAbsence>();
    let skippedByFilter = 0;

    for (const chunk of splitIntoChunks(start, finish, 31)) {
      let page = 0;
      let totalPages = 1;

      while (page < totalPages) {
        const path = `/absences/lastupdate/start/${formatNextiDate(chunk.start)}/finish/${formatNextiDate(chunk.finish)}`;
        const payload = await fetchNextiReadOnly(nextiBaseUrl, path, token, {
          page: String(page),
          size: String(pageSize),
        });
        const absences = extractContent<NextiAbsence>(payload);
        totalPages = Number(payload.totalPages ?? payload.value?.totalPages ?? 1);

        for (const absence of absences) {
          if (!absence.id || !absence.personId || !absence.startDateTime) continue;
          if (!matchesMedicalFilter(absence, filters)) {
            skippedByFilter += 1;
            continue;
          }

          absencesById.set(absence.id, absence);
        }

        page += 1;
      }
    }

    const absences = Array.from(absencesById.values());
    const personIds = new Set(absences.map((absence) => absence.personId).filter(isNumber));
    const personMap = absences.length > 0 ? await fetchAllPersons(nextiBaseUrl, token, personIds) : new Map();
    const existingIds = await fetchExistingAbsenceIds(
      admin,
      absences.map((absence) => absence.id).filter(isNumber),
    );

    await upsertPersons(admin, absences, personMap);
    await upsertAbsences(admin, absences, personMap);

    const imported = absences.filter((absence) => absence.id && !existingIds.has(absence.id)).length;
    const updated = absences.length - imported;

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
          absencesProcessed: absences.length,
          personsLoaded: personMap.size,
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
  const basicCredentials = btoa(`${clientId}:${clientSecret}`);
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicCredentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  if (!response.ok) {
    throw new Error(`Falha ao autenticar na Nexti: ${response.status}`);
  }

  const payload = await response.json();
  if (!payload.access_token) {
    throw new Error("Resposta de token da Nexti sem access_token");
  }

  return payload.access_token as string;
}

async function fetchNextiReadOnly(
  baseUrl: string,
  path: string,
  token: string,
  query?: Record<string, string>,
): Promise<Record<string, any>> {
  if (!ALLOWED_NEXTI_READ_PATHS.some((allowedPath) => path.startsWith(allowedPath))) {
    throw new Error(`Endpoint Nexti nao permitido para esta aplicacao: ${path}`);
  }

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

async function fetchAllPersons(baseUrl: string, token: string, personIds: Set<number>): Promise<Map<number, NextiPerson>> {
  const persons = new Map<number, NextiPerson>();
  let page = 0;
  let totalPages = 1;

  while (page < totalPages && persons.size < personIds.size) {
    const payload = await fetchNextiReadOnly(baseUrl, "/persons/all", token, {
      page: String(page),
      size: "1000",
    });
    const content = extractContent<NextiPerson>(payload);
    totalPages = Number(payload.totalPages ?? payload.value?.totalPages ?? 1);

    for (const person of content) {
      if (person.id && personIds.has(person.id)) {
        persons.set(person.id, person);
      }
    }

    page += 1;
  }

  return persons;
}

async function upsertPersons(admin: SupabaseAdmin, absences: NextiAbsence[], personMap: Map<number, NextiPerson>) {
  const rowsByPersonId = new Map<number, Record<string, unknown>>();

  for (const absence of absences) {
    if (!absence.personId) continue;
    const person = personMap.get(absence.personId) ?? null;
    rowsByPersonId.set(absence.personId, {
      person_id_nexti: absence.personId,
      matricula: person?.enrolment ?? null,
      nome: person?.name ?? `Colaborador ${absence.personId}`,
      cargo: person?.nameCareer ?? null,
      posto: person?.workplaceName ?? person?.businessUnitName ?? null,
      empresa: person?.externalCompanyId ?? (person?.companyId ? String(person.companyId) : null),
      situacao: person?.personSituationId ? situationLabel(person.personSituationId) : null,
      ultima_atualizacao: toTimestamp(person?.lastUpdate) ?? toTimestamp(absence.lastUpdate),
      raw_json: person ?? { id: absence.personId },
    });
  }

  for (const rows of chunkArray(Array.from(rowsByPersonId.values()), 500)) {
    const { error } = await admin.from("colaboradores").upsert(rows, { onConflict: "person_id_nexti" });
    if (error) throw new Error(`Erro ao salvar colaboradores: ${error.message}`);
  }
}

async function upsertAbsences(
  admin: SupabaseAdmin,
  absences: NextiAbsence[],
  personMap: Map<number, NextiPerson>,
) {
  const rows = absences.flatMap((absence) => {
    if (!absence.id || !absence.personId || !absence.startDateTime) return [];
    const start = toDateOnly(absence.startDateTime);
    const finish = toDateOnly(absence.finishDateTime ?? absence.startDateTime);
    if (!start || !finish) return [];
    const person = personMap.get(absence.personId) ?? null;
    const cid = [absence.cidCode, absence.cidDescription].filter(Boolean).join(" - ") || null;

    return [{
      id_nexti: absence.id,
      person_id_nexti: absence.personId,
      matricula: person?.enrolment ?? null,
      data_inicio: start,
      data_fim: finish,
      dias: inclusiveDays(absence.startDateTime, absence.finishDateTime),
      data_lancamento: toTimestamp(absence.lastUpdate),
      lancado_por: absence.userRegisterId ? String(absence.userRegisterId) : null,
      cid,
      observacao: absence.note ?? null,
      tipo_ausencia_id: absence.absenceSituationId ?? null,
      tipo_ausencia_external_id: absence.absenceSituationExternalId ?? null,
      removido: Boolean(absence.removed),
      raw_json: absence,
    }];
  });

  for (const chunk of chunkArray(rows, 500)) {
    const { error } = await admin.from("atestados").upsert(chunk, { onConflict: "id_nexti" });
    if (error) throw new Error(`Erro ao salvar atestados: ${error.message}`);
  }
}

async function fetchExistingAbsenceIds(admin: SupabaseAdmin, ids: number[]): Promise<Set<number>> {
  const existing = new Set<number>();

  for (const chunk of chunkArray(ids, 500)) {
    const { data, error } = await admin.from("atestados").select("id_nexti").in("id_nexti", chunk);
    if (error) throw new Error(`Erro ao consultar atestados existentes: ${error.message}`);
    for (const row of data ?? []) {
      if (typeof row.id_nexti === "number") existing.add(row.id_nexti);
    }
  }

  return existing;
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
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => Number(item))
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

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
