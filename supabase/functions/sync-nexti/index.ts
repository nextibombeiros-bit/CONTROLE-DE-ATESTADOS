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
  cidId?: number;
  cidCode?: string;
  cidDescription?: string;
  medicalDoctorId?: number;
  medicalDoctorName?: string;
  medicalDoctorCrm?: string;
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
  demissionDate?: string;
  userAccountId?: number;
  [key: string]: unknown;
};

type NextiAbsenceSituation = {
  id?: number;
  externalId?: string;
  name?: string;
  absenceTypeId?: number;
  active?: boolean;
  cid?: boolean;
  medicalDoctor?: boolean;
  initials?: string;
  [key: string]: unknown;
};

type NextiUserAccount = {
  id?: number;
  name?: string;
  email?: string;
  profileName?: string;
  status?: boolean;
  [key: string]: unknown;
};

type MedicalFilterConfig = {
  ids: Set<number>;
  externalIds: Set<string>;
};

type SituationIndex = {
  all: NextiAbsenceSituation[];
  byId: Map<number, NextiAbsenceSituation>;
  byExternalId: Map<string, NextiAbsenceSituation>;
  filters: MedicalFilterConfig;
  detectedMedicalIds: Set<number>;
  detectedMedicalExternalIds: Set<string>;
};

type SyncWindow = {
  automatic: boolean;
  start: Date;
  finish: Date;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-source",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DAY_MS = 24 * 60 * 60 * 1000;
const RUNNING_SYNC_TIMEOUT_MINUTES = 20;
const ALLOWED_NEXTI_READ_PATHS = [
  "/absences/lastupdate/",
  "/absencesituations/",
  "/persons/",
  "/persons/all",
  "/useraccounts/startdate/",
];

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
  const pageSize = clampNumber(await readPageSize(request), 10, 1000, 200);

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const body = await safeJson(request);
  const now = new Date();
  const syncWindow = await resolveSyncWindow(admin, body, now);
  const filterConfig = readMedicalFilters();

  if (await hasRunningSync(admin, now)) {
    return json({ skipped: true, reason: "Sincronizacao ja em execucao" }, 202);
  }

  const { data: log, error: logError } = await admin
    .from("sincronizacoes")
    .insert({
      status: "em_execucao",
      periodo_inicio: syncWindow.start.toISOString(),
      periodo_fim: syncWindow.finish.toISOString(),
      detalhes: {
        automatic: syncWindow.automatic,
        source: request.headers.get("x-sync-source") ?? "http",
      },
    })
    .select("id")
    .single();

  if (logError) {
    return json({ error: logError.message }, 500);
  }

  try {
    const token = await getNextiToken(nextiTokenUrl, nextiClientId, nextiClientSecret);
    const situationIndex = await fetchAbsenceSituations(nextiBaseUrl, token, filterConfig);
    const { absences, skippedByFilter, maxLastUpdateSeen } = await fetchMedicalAbsences(
      nextiBaseUrl,
      token,
      syncWindow,
      pageSize,
      situationIndex,
    );

    const trackedPersonIds = await fetchTrackedPersonIds(admin);
    const relevantPersonIds = new Set<number>(trackedPersonIds);
    for (const absence of absences) {
      if (isNumber(absence.personId)) {
        relevantPersonIds.add(absence.personId);
      }
    }

    const personMap = relevantPersonIds.size > 0
      ? await fetchAllPersons(nextiBaseUrl, token, relevantPersonIds)
      : new Map<number, NextiPerson>();
    const existingIds = await fetchExistingAbsenceIds(
      admin,
      absences.map((absence) => absence.id).filter(isNumber),
    );

    const userMap = await fetchUserAccounts(nextiBaseUrl, token, now);

    await upsertPersons(admin, absences, personMap);
    await upsertAbsences(admin, absences, personMap, userMap, situationIndex);
    await refreshExistingAbsenceMetadata(admin, situationIndex);
    await refreshExistingUserNames(admin, userMap);

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
          automatic: syncWindow.automatic,
          source: request.headers.get("x-sync-source") ?? "http",
          skippedByFilter,
          absencesProcessed: absences.length,
          personsLoaded: personMap.size,
          userAccountsLoaded: userMap.size,
          medicalSituationsDetected: situationIndex.detectedMedicalIds.size +
            situationIndex.detectedMedicalExternalIds.size,
          maxLastUpdateSeen: maxLastUpdateSeen?.toISOString() ?? null,
          filterMode: filterConfig.ids.size > 0 || filterConfig.externalIds.size > 0 ? "explicit" : "automatic",
        },
      })
      .eq("id", log.id);

    return json({
      automatic: syncWindow.automatic,
      imported,
      updated,
      skippedByFilter,
      absencesProcessed: absences.length,
    });
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

async function readPageSize(request: Request): Promise<number | null> {
  const body = await safeJson(request.clone());
  return typeof body.pageSize === "number" ? body.pageSize : null;
}

function clampNumber(value: number | null, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function readIntEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

function parseInputDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function resolveSyncWindow(
  admin: SupabaseAdmin,
  body: Record<string, unknown>,
  now: Date,
): Promise<SyncWindow> {
  const explicitStart = parseInputDate(body.startLastUpdate);
  const explicitFinish = parseInputDate(body.finishLastUpdate);

  if (explicitStart || explicitFinish) {
    const finish = explicitFinish ?? now;
    const start = explicitStart ?? new Date(finish.getTime() - 30 * DAY_MS);
    return { automatic: false, start, finish };
  }

  const initialLookbackDays = readIntEnv("NEXTI_SYNC_INITIAL_LOOKBACK_DAYS", 365);
  const overlapMinutes = readIntEnv("NEXTI_SYNC_OVERLAP_MINUTES", 15);
  const { data, error } = await admin
    .from("sincronizacoes")
    .select("finalizado_em, periodo_fim")
    .eq("status", "sucesso")
    .order("finalizado_em", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Erro ao consultar ultima sincronizacao: ${error.message}`);
  }

  const latestReference = parseInputDate(data?.periodo_fim ?? data?.finalizado_em ?? null);
  if (!latestReference) {
    return {
      automatic: true,
      start: new Date(now.getTime() - initialLookbackDays * DAY_MS),
      finish: now,
    };
  }

  return {
    automatic: true,
    start: new Date(latestReference.getTime() - overlapMinutes * 60 * 1000),
    finish: now,
  };
}

async function hasRunningSync(admin: SupabaseAdmin, now: Date): Promise<boolean> {
  const startedAfter = new Date(now.getTime() - RUNNING_SYNC_TIMEOUT_MINUTES * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from("sincronizacoes")
    .select("id")
    .eq("status", "em_execucao")
    .gte("iniciado_em", startedAfter)
    .order("iniciado_em", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Erro ao verificar sincronizacao concorrente: ${error.message}`);
  }

  return Boolean(data?.id);
}

function formatNextiDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const year = date.getUTCFullYear();
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${day}${month}${year}${hours}${minutes}${seconds}`;
}

function formatNextiSimpleDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const year = date.getUTCFullYear();
  return `${day}${month}${year}`;
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
): Promise<Record<string, unknown> | unknown[]> {
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
    if (isNextiNoDataResponse(path, response.status, text)) {
      return [];
    }
    throw new Error(`Nexti ${path} retornou ${response.status}: ${text.slice(0, 240)}`);
  }

  return await response.json();
}

function isNextiNoDataResponse(path: string, status: number, payload: string): boolean {
  if (status !== 409) return false;
  if (!path.startsWith("/absences/lastupdate/") && !path.startsWith("/useraccounts/startdate/")) {
    return false;
  }

  const message = normalizeText(payload);
  return message.includes("nao foi encontrado nenhum dado");
}

function extractContent<T>(payload: Record<string, unknown> | unknown[]): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (Array.isArray((payload as Record<string, unknown>).content)) {
    return (payload as Record<string, unknown>).content as T[];
  }
  const value = (payload as Record<string, unknown>).value;
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).content)) {
    return (value as Record<string, unknown>).content as T[];
  }
  return [];
}

function extractSingleValue<T>(payload: Record<string, unknown> | unknown[]): T | null {
  if (Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>).value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as T;
  }
  return null;
}

function readTotalPages(payload: Record<string, unknown> | unknown[]): number {
  if (Array.isArray(payload)) return 1;
  const root = payload as Record<string, unknown>;
  if (typeof root.totalPages === "number") return root.totalPages;
  if (root.value && typeof root.value === "object" && !Array.isArray(root.value)) {
    const nested = root.value as Record<string, unknown>;
    if (typeof nested.totalPages === "number") return nested.totalPages;
  }
  return 1;
}

function readMedicalFilters(): MedicalFilterConfig {
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

async function fetchAbsenceSituations(
  baseUrl: string,
  token: string,
  filters: MedicalFilterConfig,
): Promise<SituationIndex> {
  const all: NextiAbsenceSituation[] = [];
  const byId = new Map<number, NextiAbsenceSituation>();
  const byExternalId = new Map<string, NextiAbsenceSituation>();
  const detectedMedicalIds = new Set<number>();
  const detectedMedicalExternalIds = new Set<string>();

  let page = 0;
  let totalPages = 1;

  while (page < totalPages) {
    const payload = await fetchNextiReadOnly(baseUrl, "/absencesituations/all", token, {
      page: String(page),
      size: "500",
    });
    const content = extractContent<NextiAbsenceSituation>(payload);
    totalPages = readTotalPages(payload);

    for (const situation of content) {
      all.push(situation);
      if (isNumber(situation.id)) byId.set(situation.id, situation);
      if (typeof situation.externalId === "string" && situation.externalId) {
        byExternalId.set(situation.externalId, situation);
      }

      if (isMedicalSituation(situation, filters)) {
        if (isNumber(situation.id)) detectedMedicalIds.add(situation.id);
        if (typeof situation.externalId === "string" && situation.externalId) {
          detectedMedicalExternalIds.add(situation.externalId);
        }
      }
    }

    page += 1;
  }

  if (
    filters.ids.size === 0 &&
    filters.externalIds.size === 0 &&
    detectedMedicalIds.size === 0 &&
    detectedMedicalExternalIds.size === 0
  ) {
    throw new Error(
      "Nenhuma situacao de ausencia medica foi identificada automaticamente. Configure NEXTI_MEDICAL_ABSENCE_SITUATION_IDS ou NEXTI_MEDICAL_ABSENCE_SITUATION_EXTERNAL_IDS.",
    );
  }

  return {
    all,
    byId,
    byExternalId,
    filters,
    detectedMedicalIds,
    detectedMedicalExternalIds,
  };
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function isMedicalSituation(situation: NextiAbsenceSituation, filters: MedicalFilterConfig): boolean {
  if (isNumber(situation.id) && filters.ids.has(situation.id)) return true;
  if (typeof situation.externalId === "string" && filters.externalIds.has(situation.externalId)) return true;
  if (filters.ids.size > 0 || filters.externalIds.size > 0) return false;

  const name = normalizeText(situation.name);
  const active = situation.active !== false;
  const justified = situation.absenceTypeId !== 2 && situation.absenceTypeId !== 3;
  const hasMedicalFlags = Boolean(situation.cid || situation.medicalDoctor);
  const looksMedicalByName = /(atest|medic|cid)/.test(name);
  const looksNonMedicalByName = /(ferias|falta|folga|abono|demiss|compens|dsr|licenca patern|licenca casamento)/.test(
    name,
  );

  return active && justified && !looksNonMedicalByName && (hasMedicalFlags || looksMedicalByName);
}

function resolveSituation(absence: NextiAbsence, situationIndex: SituationIndex): NextiAbsenceSituation | null {
  if (isNumber(absence.absenceSituationId)) {
    return situationIndex.byId.get(absence.absenceSituationId) ?? null;
  }
  if (typeof absence.absenceSituationExternalId === "string") {
    return situationIndex.byExternalId.get(absence.absenceSituationExternalId) ?? null;
  }
  return null;
}

function matchesMedicalAbsence(absence: NextiAbsence, situationIndex: SituationIndex): boolean {
  if (isNumber(absence.absenceSituationId) && situationIndex.filters.ids.has(absence.absenceSituationId)) return true;
  if (
    typeof absence.absenceSituationExternalId === "string" &&
    situationIndex.filters.externalIds.has(absence.absenceSituationExternalId)
  ) {
    return true;
  }

  if (situationIndex.filters.ids.size > 0 || situationIndex.filters.externalIds.size > 0) {
    return false;
  }

  const situation = resolveSituation(absence, situationIndex);
  if (situation) return isMedicalSituation(situation, situationIndex.filters);

  return Boolean(absence.cidCode || absence.medicalDoctorName || absence.medicalDoctorId);
}

async function fetchMedicalAbsences(
  baseUrl: string,
  token: string,
  syncWindow: SyncWindow,
  pageSize: number,
  situationIndex: SituationIndex,
): Promise<{ absences: NextiAbsence[]; skippedByFilter: number; maxLastUpdateSeen: Date | null }> {
  const absencesById = new Map<number, NextiAbsence>();
  let skippedByFilter = 0;
  let maxLastUpdateSeen: Date | null = null;

  for (const chunk of splitIntoChunks(syncWindow.start, syncWindow.finish, 31)) {
    let page = 0;
    let totalPages = 1;

    while (page < totalPages) {
      const path = `/absences/lastupdate/start/${formatNextiDate(chunk.start)}/finish/${formatNextiDate(chunk.finish)}`;
      const payload = await fetchNextiReadOnly(baseUrl, path, token, {
        page: String(page),
        size: String(pageSize),
      });
      const absences = extractContent<NextiAbsence>(payload);
      totalPages = readTotalPages(payload);

      for (const absence of absences) {
        if (!absence.id || !absence.personId || !absence.startDateTime) continue;
        if (!matchesMedicalAbsence(absence, situationIndex)) {
          skippedByFilter += 1;
          continue;
        }

        const lastUpdate = parseNextiDate(absence.lastUpdate);
        if (lastUpdate && (!maxLastUpdateSeen || lastUpdate > maxLastUpdateSeen)) {
          maxLastUpdateSeen = lastUpdate;
        }

        absencesById.set(absence.id, absence);
      }

      page += 1;
    }
  }

  return {
    absences: Array.from(absencesById.values()),
    skippedByFilter,
    maxLastUpdateSeen,
  };
}

async function fetchTrackedPersonIds(admin: SupabaseAdmin): Promise<Set<number>> {
  const ids = new Set<number>();
  const pageSize = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await admin
      .from("colaboradores")
      .select("person_id_nexti")
      .eq("ativo", true)
      .range(from, from + pageSize - 1);

    if (error) {
      throw new Error(`Erro ao consultar colaboradores acompanhados: ${error.message}`);
    }

    for (const row of data ?? []) {
      if (isNumber(row.person_id_nexti)) ids.add(row.person_id_nexti);
    }

    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  return ids;
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
    totalPages = readTotalPages(payload);

    for (const person of content) {
      if (isNumber(person.id) && personIds.has(person.id)) {
        persons.set(person.id, person);
      }
    }

    page += 1;
  }

  const missingIds = Array.from(personIds).filter((personId) => !persons.has(personId));
  for (const personId of missingIds) {
    const payload = await fetchNextiReadOnly(baseUrl, `/persons/${personId}`, token);
    const person = extractSingleValue<NextiPerson>(payload);
    if (person && isNumber(person.id)) {
      persons.set(person.id, person);
    }
  }

  return persons;
}

async function fetchUserAccounts(
  baseUrl: string,
  token: string,
  now: Date,
): Promise<Map<number, NextiUserAccount>> {
  const userMap = new Map<number, NextiUserAccount>();
  const startDate = Deno.env.get("NEXTI_USER_ACCOUNT_LOOKBACK_START") ?? "01012000";
  const finishDate = formatNextiSimpleDate(now);

  try {
    const payload = await fetchNextiReadOnly(
      baseUrl,
      `/useraccounts/startdate/${startDate}/finishdate/${finishDate}`,
      token,
    );
    const accounts = extractContent<NextiUserAccount>(payload);

    for (const account of accounts) {
      if (isNumber(account.id)) {
        userMap.set(account.id, account);
      }
    }
  } catch {
    return userMap;
  }

  return userMap;
}

async function upsertPersons(
  admin: SupabaseAdmin,
  absences: NextiAbsence[],
  personMap: Map<number, NextiPerson>,
) {
  const rowsByPersonId = new Map<number, Record<string, unknown>>();

  for (const person of personMap.values()) {
    if (!isNumber(person.id)) continue;
    rowsByPersonId.set(person.id, {
      person_id_nexti: person.id,
      matricula: person.enrolment ?? null,
      nome: person.name ?? `Colaborador ${person.id}`,
      cargo: person.nameCareer ?? null,
      posto: person.workplaceName ?? person.businessUnitName ?? null,
      empresa: person.externalCompanyId ?? (person.companyId ? String(person.companyId) : null),
      situacao: isNumber(person.personSituationId) ? situationLabel(person.personSituationId) : null,
      ultima_atualizacao: toTimestamp(person.lastUpdate),
      ativo: person.personSituationId !== 3,
      data_desligamento: toDateOnly(person.demissionDate),
      user_account_id_nexti: person.userAccountId ?? null,
      raw_json: person,
    });
  }

  for (const absence of absences) {
    if (!isNumber(absence.personId) || rowsByPersonId.has(absence.personId)) continue;
    rowsByPersonId.set(absence.personId, {
      person_id_nexti: absence.personId,
      matricula: null,
      nome: `Colaborador ${absence.personId}`,
      cargo: null,
      posto: null,
      empresa: null,
      situacao: null,
      ultima_atualizacao: toTimestamp(absence.lastUpdate),
      ativo: true,
      data_desligamento: null,
      user_account_id_nexti: null,
      raw_json: { id: absence.personId },
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
  userMap: Map<number, NextiUserAccount>,
  situationIndex: SituationIndex,
) {
  const rows = absences.flatMap((absence) => {
    if (!absence.id || !absence.personId || !absence.startDateTime) return [];
    const start = toDateOnly(absence.startDateTime);
    const finish = toDateOnly(absence.finishDateTime ?? absence.startDateTime);
    if (!start || !finish) return [];

    const person = personMap.get(absence.personId) ?? null;
    const situation = resolveSituation(absence, situationIndex);
    const user = isNumber(absence.userRegisterId) ? userMap.get(absence.userRegisterId) ?? null : null;
    const cid = [absence.cidCode, absence.cidDescription].filter(Boolean).join(" - ") || null;
    const medico = [absence.medicalDoctorName, absence.medicalDoctorCrm].filter(Boolean).join(" / ") || null;
    const lancadoPorNome = user?.name ?? null;
    const lancadoPorTexto = lancadoPorNome ?? (isNumber(absence.userRegisterId) ? String(absence.userRegisterId) : null);

    return [{
      id_nexti: absence.id,
      person_id_nexti: absence.personId,
      matricula: person?.enrolment ?? null,
      data_inicio: start,
      data_fim: finish,
      dias: inclusiveDays(absence.startDateTime, absence.finishDateTime),
      data_lancamento: toTimestamp(absence.lastUpdate),
      lancado_por: lancadoPorTexto,
      cid,
      observacao: absence.note ?? null,
      tipo_ausencia_id: absence.absenceSituationId ?? null,
      tipo_ausencia_external_id: absence.absenceSituationExternalId ?? null,
      tipo_ausencia_nome: situation?.name ?? absence.absenceSituationExternalId ?? null,
      eh_atestado_medico: matchesMedicalAbsence(absence, situationIndex),
      removido: Boolean(absence.removed),
      lancado_por_id: absence.userRegisterId ?? null,
      lancado_por_nome: lancadoPorNome,
      medico,
      raw_json: absence,
    }];
  });

  for (const chunk of chunkArray(rows, 500)) {
    const { error } = await admin.from("atestados").upsert(chunk, { onConflict: "id_nexti" });
    if (error) throw new Error(`Erro ao salvar atestados: ${error.message}`);
  }
}

async function refreshExistingAbsenceMetadata(admin: SupabaseAdmin, situationIndex: SituationIndex) {
  for (const situation of situationIndex.all) {
    const patch = {
      tipo_ausencia_nome: situation.name ?? null,
      eh_atestado_medico: isMedicalSituation(situation, situationIndex.filters),
    };

    if (isNumber(situation.id)) {
      const { error } = await admin.from("atestados").update(patch).eq("tipo_ausencia_id", situation.id);
      if (error) throw new Error(`Erro ao atualizar metadata de ausencia: ${error.message}`);
      continue;
    }

    if (typeof situation.externalId === "string" && situation.externalId) {
      const { error } = await admin
        .from("atestados")
        .update(patch)
        .is("tipo_ausencia_id", null)
        .eq("tipo_ausencia_external_id", situation.externalId);
      if (error) throw new Error(`Erro ao atualizar metadata de ausencia: ${error.message}`);
    }
  }
}

async function refreshExistingUserNames(admin: SupabaseAdmin, userMap: Map<number, NextiUserAccount>) {
  for (const [userId, user] of userMap.entries()) {
    if (!user.name) continue;
    const patch = {
      lancado_por: user.name,
      lancado_por_nome: user.name,
    };
    const { error } = await admin.from("atestados").update(patch).eq("lancado_por_id", userId);
    if (error) throw new Error(`Erro ao atualizar nomes de usuarios Nexti: ${error.message}`);
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
