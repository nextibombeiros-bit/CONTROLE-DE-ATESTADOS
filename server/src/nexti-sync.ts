import type { CompatDbClient } from "./pg-compat.js";

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
  careerId?: number;
  workplaceId?: number;
  companyId?: number;
  externalCompanyId?: string;
  businessUnitId?: number;
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
  personName?: string;
  profileName?: string;
  status?: boolean;
  [key: string]: unknown;
};

type NextiCareer = {
  id?: number;
  name?: string;
  active?: boolean;
  [key: string]: unknown;
};

type NextiBusinessUnit = {
  id?: number;
  name?: string;
  companyName?: string;
  active?: boolean;
  [key: string]: unknown;
};

type NextiWorkplace = {
  id?: number;
  name?: string;
  businessUnitId?: number;
  companyId?: number;
  active?: boolean;
  [key: string]: unknown;
};

type NextiCompany = {
  id?: number;
  companyName?: string;
  fantasyName?: string;
  active?: boolean;
  [key: string]: unknown;
};

type ReferenceData = {
  careers: Map<number, NextiCareer>;
  businessUnits: Map<number, NextiBusinessUnit>;
  workplaces: Map<number, NextiWorkplace>;
  companies: Map<number, NextiCompany>;
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

type RecentSync = {
  finishedAt: Date;
  nextAllowedAt: Date;
  cooldownSeconds: number;
};

type WriteStats = {
  inserted: number;
  updated: number;
  skipped: number;
  written: number;
  insertedKeys: LookupValue[];
  updatedKeys: LookupValue[];
};

type LookupValue = string | number;

const DAY_MS = 24 * 60 * 60 * 1000;
const RUNNING_SYNC_TIMEOUT_MINUTES = 20;
const DEFAULT_SYNC_MIN_INTERVAL_SECONDS = 60;
const ATESTADO_NAME_PATTERN = /atestad/;
const NON_ATESTADO_NAME_PATTERN =
  /(ferias|falta|folga|abono|demiss|compens|dsr|matern|amament|nascimento|filho|patern|casament|luto|doac|comparec|eleitoral|adocao|aleitamento)/;
const ALLOWED_NEXTI_READ_PATHS = [
  "/absences/lastupdate/",
  "/absencesituations/",
  "/businessunits/",
  "/careers/",
  "/companies/",
  "/persons/",
  "/persons/all",
  "/useraccounts/startdate/",
  "/workplaces/",
];

const COLABORADOR_COMPARE_COLUMNS = [
  "matricula",
  "nome",
  "cargo",
  "posto",
  "empresa",
  "situacao",
  "ultima_atualizacao",
  "ativo",
  "data_desligamento",
  "user_account_id_nexti",
];

const ATESTADO_COMPARE_COLUMNS = [
  "person_id_nexti",
  "matricula",
  "data_inicio",
  "data_fim",
  "dias",
  "data_lancamento",
  "lancado_por",
  "cid",
  "observacao",
  "tipo_ausencia_id",
  "tipo_ausencia_external_id",
  "tipo_ausencia_nome",
  "eh_atestado_medico",
  "removido",
  "lancado_por_id",
  "lancado_por_nome",
  "medico",
];

const TIMESTAMP_COMPARE_COLUMNS = new Set(["ultima_atualizacao", "data_lancamento"]);

export type SyncRequestBody = {
  automatic?: boolean;
  startLastUpdate?: string;
  finishLastUpdate?: string;
  pageSize?: number;
};

export type SyncResult = {
  automatic?: boolean;
  imported?: number;
  updated?: number;
  skippedByFilter?: number;
  absencesProcessed?: number;
  skipped?: boolean;
  reason?: string;
  latestSyncAt?: string;
  nextAllowedAt?: string;
  error?: string;
};

export async function runNextiSync(
  admin: CompatDbClient,
  body: SyncRequestBody = {},
  options: { source?: string } = {},
): Promise<{ status: number; payload: SyncResult }> {
  const nextiClientId = requireEnv("NEXTI_CLIENT_ID");
  const nextiClientSecret = requireEnv("NEXTI_CLIENT_SECRET");
  const nextiBaseUrl = env("NEXTI_API_BASE_URL") ?? "https://api.nexti.com";
  const nextiTokenUrl = env("NEXTI_TOKEN_URL") ?? "https://api.nexti.com/security/oauth/token";
  const pageSize = clampNumber(body.pageSize ?? null, 10, 1000, 200);
  const now = new Date();

  if (await hasRunningSync(admin, now)) {
    return { status: 202, payload: { skipped: true, reason: "Sincronizacao ja em execucao" } };
  }

  const recentSync = await findRecentSuccessfulSync(admin, now);
  if (recentSync) {
    return { status: 202, payload: {
      skipped: true,
      reason: `Ultima sincronizacao concluida ha menos de ${recentSync.cooldownSeconds} segundos`,
      latestSyncAt: recentSync.finishedAt.toISOString(),
      nextAllowedAt: recentSync.nextAllowedAt.toISOString(),
    } };
  }

  const syncWindow = await resolveSyncWindow(admin, body, now);
  const filterConfig = readMedicalFilters();

  const { data: log, error: logError } = await admin
    .from("sincronizacoes")
    .insert({
      status: "em_execucao",
      periodo_inicio: syncWindow.start.toISOString(),
      periodo_fim: syncWindow.finish.toISOString(),
      detalhes: {
        automatic: syncWindow.automatic,
        source: options.source ?? "http",
      },
    })
    .select("id")
    .single();

  if (logError) {
    return { status: 500, payload: { error: logError.message } };
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

    const relevantPersonIds = new Set<number>();
    for (const absence of absences) {
      if (isNumber(absence.personId)) {
        relevantPersonIds.add(absence.personId);
      }
    }

    const personMap = relevantPersonIds.size > 0
      ? await fetchAllPersons(nextiBaseUrl, token, relevantPersonIds)
      : new Map<number, NextiPerson>();
    const references = await fetchReferenceData(nextiBaseUrl, token, personMap);
    const operatorIds = collectOperatorIds(absences);
    const userMap = operatorIds.size > 0 ? await fetchUserAccounts(nextiBaseUrl, token, now) : new Map<number, NextiUserAccount>();
    const operatorNames = await resolveOperatorNames(admin, operatorIds, userMap, personMap);

    const personsWritten = await upsertPersons(admin, absences, personMap, references);
    const absenceWriteStats = await upsertAbsences(admin, absences, personMap, operatorNames, situationIndex);
    const notificationStats = await enqueueAndDispatchNotificationEvents(admin, {
      insertedAbsenceIds: absenceWriteStats.insertedKeys.map(Number).filter(Number.isFinite),
      changedAbsenceIds: [...absenceWriteStats.insertedKeys, ...absenceWriteStats.updatedKeys].map(Number).filter(Number.isFinite),
    });

    const imported = absenceWriteStats.inserted;
    const updated = absenceWriteStats.updated;

    await admin
      .from("sincronizacoes")
      .update({
        status: "sucesso",
        finalizado_em: new Date().toISOString(),
        quantidade_importada: imported,
        quantidade_atualizada: updated,
        detalhes: {
          automatic: syncWindow.automatic,
          source: options.source ?? "http",
          skippedByFilter,
          absencesProcessed: absences.length,
          absencesWritten: absenceWriteStats.written,
          absencesSkippedUnchanged: absenceWriteStats.skipped,
          personsWritten,
          personsLoaded: personMap.size,
          userAccountsLoaded: userMap.size,
          operatorNamesResolved: operatorNames.size,
          notificationsCreated: notificationStats.created,
          notificationsSent: notificationStats.sent,
          notificationsFailed: notificationStats.failed,
          medicalSituationsDetected: situationIndex.detectedMedicalIds.size +
            situationIndex.detectedMedicalExternalIds.size,
          maxLastUpdateSeen: maxLastUpdateSeen?.toISOString() ?? null,
          filterMode: filterConfig.ids.size > 0 || filterConfig.externalIds.size > 0 ? "explicit" : "automatic",
        },
      })
      .eq("id", log.id);

    return { status: 200, payload: {
      automatic: syncWindow.automatic,
      imported,
      updated,
      skippedByFilter,
      absencesProcessed: absences.length,
    } };
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

    return { status: 500, payload: { error: message } };
  }
}

function requireEnv(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`Variavel ${name} nao configurada`);
  return value;
}

function env(name: string): string | undefined {
  return process.env[name];
}

function clampNumber(value: number | null, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function readIntEnv(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

function readOptionalIntEnv(name: string): number | null {
  const raw = env(name);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.floor(value) : null;
}

function parseInputDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function resolveSyncWindow(
  admin: CompatDbClient,
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

  const automatic = body.automatic === true;
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
      automatic,
      start: new Date(now.getTime() - initialLookbackDays * DAY_MS),
      finish: now,
    };
  }

  return {
    automatic,
    start: new Date(latestReference.getTime() - overlapMinutes * 60 * 1000),
    finish: now,
  };
}

async function findRecentSuccessfulSync(admin: CompatDbClient, now: Date): Promise<RecentSync | null> {
  const minuteCooldown = readOptionalIntEnv("NEXTI_SYNC_MIN_INTERVAL_MINUTES");
  const cooldownSeconds = Math.max(
    0,
    readIntEnv(
      "NEXTI_SYNC_MIN_INTERVAL_SECONDS",
      minuteCooldown === null ? DEFAULT_SYNC_MIN_INTERVAL_SECONDS : minuteCooldown * 60,
    ),
  );
  if (cooldownSeconds === 0) return null;

  const { data, error } = await admin
    .from("sincronizacoes")
    .select("finalizado_em, iniciado_em")
    .eq("status", "sucesso")
    .order("finalizado_em", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Erro ao consultar cooldown de sincronizacao: ${error.message}`);
  }

  const finishedAt = parseInputDate(data?.finalizado_em ?? data?.iniciado_em ?? null);
  if (!finishedAt) return null;

  const nextAllowedAt = new Date(finishedAt.getTime() + cooldownSeconds * 1000);
  if (now < nextAllowedAt) {
    return { finishedAt, nextAllowedAt, cooldownSeconds };
  }

  return null;
}

async function hasRunningSync(admin: CompatDbClient, now: Date): Promise<boolean> {
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

  const payload = await response.json() as { access_token?: string };
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

  return await response.json() as Record<string, unknown> | unknown[];
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
    (env("NEXTI_MEDICAL_ABSENCE_SITUATION_IDS") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item)),
  );

  const externalIds = new Set(
    (env("NEXTI_MEDICAL_ABSENCE_SITUATION_EXTERNAL_IDS") ?? "")
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
  const name = normalizeText(situation.name);
  const active = situation.active !== false;
  const justified = situation.absenceTypeId !== 2 && situation.absenceTypeId !== 3;
  const explicitMatch = (isNumber(situation.id) && filters.ids.has(situation.id)) ||
    (typeof situation.externalId === "string" && filters.externalIds.has(situation.externalId));
  const looksLikeAtestado = ATESTADO_NAME_PATTERN.test(name);
  const looksExcluded = NON_ATESTADO_NAME_PATTERN.test(name);

  if (!active || !justified || looksExcluded) {
    return false;
  }

  if (explicitMatch) {
    return looksLikeAtestado;
  }

  if (filters.ids.size > 0 || filters.externalIds.size > 0) {
    return false;
  }

  return looksLikeAtestado;
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
  const situation = resolveSituation(absence, situationIndex);
  if (situation) return isMedicalSituation(situation, situationIndex.filters);
  return false;
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

async function fetchTrackedPersonIds(admin: CompatDbClient): Promise<Set<number>> {
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

async function fetchReferenceData(
  baseUrl: string,
  token: string,
  personMap: Map<number, NextiPerson>,
): Promise<ReferenceData> {
  const careerIds = new Set<number>();
  const businessUnitIds = new Set<number>();
  const workplaceIds = new Set<number>();
  const companyIds = new Set<number>();

  for (const person of personMap.values()) {
    if (isNumber(person.careerId)) careerIds.add(person.careerId);
    if (isNumber(person.businessUnitId)) businessUnitIds.add(person.businessUnitId);
    if (isNumber(person.workplaceId)) workplaceIds.add(person.workplaceId);
    if (isNumber(person.companyId)) companyIds.add(person.companyId);
  }

  const [careers, businessUnits, workplaces, companies] = await Promise.all([
    fetchReferenceMap<NextiCareer>(baseUrl, "/careers/all", token, careerIds),
    fetchReferenceMap<NextiBusinessUnit>(baseUrl, "/businessunits/all", token, businessUnitIds),
    fetchReferenceMap<NextiWorkplace>(baseUrl, "/workplaces/all", token, workplaceIds),
    fetchReferenceMap<NextiCompany>(baseUrl, "/companies/all", token, companyIds),
  ]);

  return {
    careers,
    businessUnits,
    workplaces,
    companies,
  };
}

async function fetchReferenceMap<T extends { id?: number }>(
  baseUrl: string,
  path: string,
  token: string,
  ids: Set<number>,
): Promise<Map<number, T>> {
  if (ids.size === 0) {
    return new Map<number, T>();
  }

  const items = await fetchPagedCollection<T>(baseUrl, path, token);
  const map = new Map<number, T>();

  for (const item of items) {
    if (!isNumber(item.id) || !ids.has(item.id)) continue;
    map.set(item.id, item);
  }

  return map;
}

async function fetchPagedCollection<T>(
  baseUrl: string,
  path: string,
  token: string,
): Promise<T[]> {
  const items: T[] = [];
  let page = 0;
  let totalPages = 1;

  while (page < totalPages) {
    const payload = await fetchNextiReadOnly(baseUrl, path, token, {
      page: String(page),
      size: "500",
    });
    const content = extractContent<T>(payload);
    items.push(...content);

    if (Array.isArray(payload)) {
      break;
    }

    totalPages = readTotalPages(payload);
    page += 1;
  }

  return items;
}

async function fetchUserAccounts(
  baseUrl: string,
  token: string,
  now: Date,
): Promise<Map<number, NextiUserAccount>> {
  const userMap = new Map<number, NextiUserAccount>();
  const startDate = env("NEXTI_USER_ACCOUNT_LOOKBACK_START") ?? "01012000";
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

function collectOperatorIds(absences: NextiAbsence[]): Set<number> {
  const ids = new Set<number>();

  for (const absence of absences) {
    if (isNumber(absence.userRegisterId)) {
      ids.add(absence.userRegisterId);
    }
  }

  return ids;
}

async function fetchUnresolvedOperatorIds(admin: CompatDbClient): Promise<Set<number>> {
  const ids = new Set<number>();
  const pageSize = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await admin
      .from("atestados")
      .select("lancado_por_id")
      .not("lancado_por_id", "is", null)
      .is("lancado_por_nome", null)
      .range(from, from + pageSize - 1);

    if (error) {
      throw new Error(`Erro ao consultar operadores sem nome: ${error.message}`);
    }

    for (const row of data ?? []) {
      if (isNumber(row.lancado_por_id)) {
        ids.add(row.lancado_por_id);
      }
    }

    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  return ids;
}

async function resolveOperatorNames(
  admin: CompatDbClient,
  operatorIds: Set<number>,
  userMap: Map<number, NextiUserAccount>,
  personMap: Map<number, NextiPerson>,
): Promise<Map<number, string>> {
  const resolved = new Map<number, string>();
  const overrides = readOperatorNameOverrides();

  for (const [operatorId, name] of overrides.entries()) {
    if (operatorIds.has(operatorId)) {
      resolved.set(operatorId, name);
    }
  }

  for (const operatorId of operatorIds) {
    const user = userMap.get(operatorId);
    const userName = firstNonEmpty(user?.name, user?.personName);
    if (userName) {
      resolved.set(operatorId, userName);
    }
  }

  for (const person of personMap.values()) {
    if (!isNumber(person.userAccountId) || !operatorIds.has(person.userAccountId)) continue;
    const personName = firstNonEmpty(person.name);
    if (personName && !resolved.has(person.userAccountId)) {
      resolved.set(person.userAccountId, personName);
    }
  }

  const missingIds = Array.from(operatorIds).filter((operatorId) => !resolved.has(operatorId));
  if (missingIds.length === 0) {
    return resolved;
  }

  for (const chunk of chunkArray(missingIds, 500)) {
    const { data, error } = await admin
      .from("colaboradores")
      .select("nome, user_account_id_nexti")
      .in("user_account_id_nexti", chunk);

    if (error) {
      throw new Error(`Erro ao consultar fallback de operadores: ${error.message}`);
    }

    for (const row of data ?? []) {
      if (!isNumber(row.user_account_id_nexti) || !row.nome) continue;
      if (!resolved.has(row.user_account_id_nexti)) {
        resolved.set(row.user_account_id_nexti, row.nome);
      }
    }
  }

  return resolved;
}

function readOperatorNameOverrides(): Map<number, string> {
  const raw = env("NEXTI_OPERATOR_NAME_OVERRIDES") ?? "";
  const map = new Map<number, string>();

  for (const entry of raw.split(";")) {
    const [idRaw, ...nameParts] = entry.split("=");
    const id = Number(idRaw?.trim());
    const name = nameParts.join("=").trim();
    if (!Number.isFinite(id) || !name) continue;
    map.set(id, name);
  }

  return map;
}

async function selectChangedRows(
  admin: CompatDbClient,
  table: "atestados" | "colaboradores",
  keyColumn: string,
  rows: Array<Record<string, unknown>>,
  compareColumns: string[],
): Promise<{ rows: Array<Record<string, unknown>> } & WriteStats> {
  const changedRows: Array<Record<string, unknown>> = [];
  const insertedKeys: LookupValue[] = [];
  const updatedKeys: LookupValue[] = [];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const chunk of chunkArray(rows, 500)) {
    const keys = chunk.map((row) => row[keyColumn]).filter(isLookupValue);
    const existingByKey = new Map<string, Record<string, unknown>>();

    if (keys.length > 0) {
      const { data, error } = await admin
        .from(table)
        .select([keyColumn, ...compareColumns].join(","))
        .in(keyColumn, keys);

      if (error) {
        throw new Error(`Erro ao consultar registros existentes em ${table}: ${error.message}`);
      }

      for (const row of data ?? []) {
        const typedRow = row as unknown as Record<string, unknown>;
        const key = typedRow[keyColumn];
        if (isLookupValue(key)) {
          existingByKey.set(String(key), typedRow);
        }
      }
    }

    for (const row of chunk) {
      const key = row[keyColumn];
      if (!isLookupValue(key)) {
        changedRows.push(row);
        updated += 1;
        updatedKeys.push(String(changedRows.length));
        continue;
      }

      const existing = existingByKey.get(String(key));
      if (!existing) {
        changedRows.push(row);
        inserted += 1;
        insertedKeys.push(key);
        continue;
      }

      if (hasChangedColumns(existing, row, compareColumns)) {
        changedRows.push(row);
        updated += 1;
        updatedKeys.push(key);
      } else {
        skipped += 1;
      }
    }
  }

  return { rows: changedRows, inserted, updated, skipped, written: changedRows.length, insertedKeys, updatedKeys };
}

function hasChangedColumns(existing: Record<string, unknown>, next: Record<string, unknown>, columns: string[]): boolean {
  return columns.some((column) => !sameDbValue(existing[column], next[column], TIMESTAMP_COMPARE_COLUMNS.has(column)));
}

function sameDbValue(current: unknown, next: unknown, timestamp: boolean): boolean {
  const currentValue = current ?? null;
  const nextValue = next ?? null;

  if (currentValue === null || nextValue === null) {
    return currentValue === nextValue;
  }

  if (timestamp) {
    const currentTime = new Date(String(currentValue)).getTime();
    const nextTime = new Date(String(nextValue)).getTime();
    return Number.isFinite(currentTime) && Number.isFinite(nextTime) && currentTime === nextTime;
  }

  if (typeof currentValue === "number" || typeof nextValue === "number") {
    return Number(currentValue) === Number(nextValue);
  }

  return currentValue === nextValue;
}

function isLookupValue(value: unknown): value is LookupValue {
  return (typeof value === "string" && value.length > 0) || isNumber(value);
}

async function upsertPersons(
  admin: CompatDbClient,
  absences: NextiAbsence[],
  personMap: Map<number, NextiPerson>,
  references: ReferenceData,
): Promise<number> {
  const rowsByPersonId = new Map<number, Record<string, unknown>>();

  for (const person of personMap.values()) {
    if (!isNumber(person.id)) continue;
    const career = isNumber(person.careerId) ? references.careers.get(person.careerId) ?? null : null;
    const businessUnit = isNumber(person.businessUnitId)
      ? references.businessUnits.get(person.businessUnitId) ?? null
      : null;
    const workplace = isNumber(person.workplaceId) ? references.workplaces.get(person.workplaceId) ?? null : null;
    const company = isNumber(person.companyId) ? references.companies.get(person.companyId) ?? null : null;

    rowsByPersonId.set(person.id, {
      person_id_nexti: person.id,
      matricula: person.enrolment ?? null,
      nome: person.name ?? `Colaborador ${person.id}`,
      cargo: firstNonEmpty(person.nameCareer, career?.name),
      posto: firstNonEmpty(person.workplaceName, workplace?.name, person.businessUnitName, businessUnit?.name),
      empresa: resolveCompanyLabel(company, businessUnit, person),
      situacao: isNumber(person.personSituationId) ? situationLabel(person.personSituationId) : null,
      ultima_atualizacao: toTimestamp(person.lastUpdate),
      ativo: !isDismissedPerson(person),
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

  const { rows: changedRows, written } = await selectChangedRows(
    admin,
    "colaboradores",
    "person_id_nexti",
    Array.from(rowsByPersonId.values()),
    COLABORADOR_COMPARE_COLUMNS,
  );

  for (const rows of chunkArray(changedRows, 500)) {
    const { error } = await admin.from("colaboradores").upsert(rows, { onConflict: "person_id_nexti" });
    if (error) throw new Error(`Erro ao salvar colaboradores: ${error.message}`);
  }

  return written;
}

async function upsertAbsences(
  admin: CompatDbClient,
  absences: NextiAbsence[],
  personMap: Map<number, NextiPerson>,
  operatorNames: Map<number, string>,
  situationIndex: SituationIndex,
): Promise<WriteStats> {
  const rows = absences.flatMap((absence) => {
    if (!absence.id || !absence.personId || !absence.startDateTime) return [];
    const start = toDateOnly(absence.startDateTime);
    const finish = toDateOnly(absence.finishDateTime ?? absence.startDateTime);
    if (!start || !finish) return [];

    const person = personMap.get(absence.personId) ?? null;
    const situation = resolveSituation(absence, situationIndex);
    const cid = [absence.cidCode, absence.cidDescription].filter(Boolean).join(" - ") || null;
    const medico = [absence.medicalDoctorName, absence.medicalDoctorCrm].filter(Boolean).join(" / ") || null;
    const lancadoPorNome = isNumber(absence.userRegisterId)
      ? operatorNames.get(absence.userRegisterId) ?? null
      : null;
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

  const writeStats = await selectChangedRows(admin, "atestados", "id_nexti", rows, ATESTADO_COMPARE_COLUMNS);

  for (const chunk of chunkArray(writeStats.rows, 500)) {
    const { error } = await admin.from("atestados").upsert(chunk, { onConflict: "id_nexti" });
    if (error) throw new Error(`Erro ao salvar atestados: ${error.message}`);
  }

  return {
    inserted: writeStats.inserted,
    updated: writeStats.updated,
    skipped: writeStats.skipped,
    written: writeStats.written,
    insertedKeys: writeStats.insertedKeys,
    updatedKeys: writeStats.updatedKeys,
  };
}

type NotificationStats = {
  created: number;
  sent: number;
  failed: number;
};

type NotificationEventType = "novo_atestado" | "mudanca_nivel_alerta";

type NotificationPayload = {
  eventType: NotificationEventType;
  eventKey: string;
  company: string | null;
  employee: {
    personId: number;
    name: string;
    matricula: string | null;
    cargo: string | null;
    unidade: string | null;
    empresa: string | null;
  };
  absence: {
    idNexti: number | null;
    startDate: string | null;
    endDate: string | null;
    days: number | null;
    launchedAt: string | null;
    launchedBy: string | null;
    cid: string | null;
    medico: string | null;
    observacao: string | null;
    tipo: string | null;
  } | null;
  alert: {
    level: "atencao" | "proximo" | "alerta";
    label: string;
    previousLevel: "ok" | "atencao" | "proximo" | null;
    previousLabel: string | null;
    totalDias: number;
    threshold: number;
    windowStart: string;
    windowEnd: string;
  } | null;
  siteUrl: string;
  createdAt: string;
};

type NotificationAbsenceRow = {
  id_nexti: number;
  person_id_nexti: number;
  matricula: string | null;
  data_inicio: string;
  data_fim: string;
  dias: number;
  data_lancamento: string | null;
  lancado_por: string | null;
  cid: string | null;
  observacao: string | null;
  tipo_ausencia_nome: string | null;
  tipo_ausencia_id: number | null;
  tipo_ausencia_external_id: string | null;
  lancado_por_nome: string | null;
  medico: string | null;
  colaborador_nome: string;
  colaborador_cargo: string | null;
  colaborador_posto: string | null;
  colaborador_empresa: string | null;
};

type CurrentAlert = {
  personId: number;
  totalDias: number;
  windowStart: string;
  windowEnd: string;
  row: NotificationAbsenceRow;
  levels: Array<{
    level: "atencao" | "proximo" | "alerta";
    label: string;
    threshold: number;
  }>;
};

const ALERT_LEVELS: CurrentAlert["levels"] = [
  { level: "atencao", label: "ATENCAO", threshold: 8 },
  { level: "proximo", label: "PROXIMO DO LIMITE", threshold: 12 },
  { level: "alerta", label: "ALERTA AFASTAMENTO", threshold: 16 },
];

async function enqueueAndDispatchNotificationEvents(
  admin: CompatDbClient,
  input: { insertedAbsenceIds: number[]; changedAbsenceIds: number[] },
): Promise<NotificationStats> {
  if (env("NOTIFICATIONS_ENABLED") === "false") {
    return { created: 0, sent: 0, failed: 0 };
  }

  const uniqueInsertedIds = uniqueNumbers(input.insertedAbsenceIds);
  const uniqueChangedIds = uniqueNumbers(input.changedAbsenceIds);
  const changedRows = await fetchNotificationAbsenceRows(admin, uniqueChangedIds);
  const changedPersonIds = uniqueNumbers(changedRows.map((row) => row.person_id_nexti));
  const alerts = await fetchCurrentAlerts(admin, changedPersonIds);
  const alertsByPersonId = new Map(alerts.map((alert) => [alert.personId, alert]));
  let created = 0;

  if (uniqueInsertedIds.length > 0) {
    const insertedRows = await fetchNotificationAbsenceRows(admin, uniqueInsertedIds);
    for (const row of insertedRows) {
      const alert = alertsByPersonId.get(row.person_id_nexti) ?? null;
      const payload = buildNewAbsencePayload(row, alert);
      created += await insertNotificationEvent(admin, payload.eventKey, payload.eventType, payload);
    }
  }

  for (const alert of alerts) {
    for (const level of alert.levels) {
      const payload = buildAlertPayload(alert, level);
      created += await insertNotificationEvent(admin, payload.eventKey, payload.eventType, payload);
    }
  }

  const dispatch = await dispatchPendingNotificationEvents(admin);
  return { created, sent: dispatch.sent, failed: dispatch.failed };
}

async function fetchNotificationAbsenceRows(admin: CompatDbClient, ids: number[]): Promise<NotificationAbsenceRow[]> {
  if (ids.length === 0) return [];

  const rows: NotificationAbsenceRow[] = [];
  for (const chunk of chunkArray(ids, 500)) {
    rows.push(
      ...(await admin.query<NotificationAbsenceRow>(
        `
        select
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
          a.tipo_ausencia_nome,
          a.tipo_ausencia_id,
          a.tipo_ausencia_external_id,
          a.lancado_por_nome,
          a.medico,
          c.nome as colaborador_nome,
          c.cargo as colaborador_cargo,
          c.posto as colaborador_posto,
          c.empresa as colaborador_empresa
        from public.atestados a
        inner join public.colaboradores c on c.person_id_nexti = a.person_id_nexti
        where a.id_nexti in (${chunk.map((_, index) => `$${index + 1}`).join(", ")})
          and a.removido = false
          and a.eh_atestado_medico = true
          and c.ativo = true
          and c.data_desligamento is null
        order by a.data_lancamento desc nulls last, a.id_nexti desc
        `,
        chunk,
      )),
    );
  }

  return rows;
}

async function fetchCurrentAlerts(admin: CompatDbClient, personIds: number[]): Promise<CurrentAlert[]> {
  if (personIds.length === 0) return [];

  const windowEnd = dateOnlyFromDate(new Date());
  const windowStart = dateOnlyFromDate(new Date(Date.now() - 59 * DAY_MS));
  const rows: NotificationAbsenceRow[] = [];

  for (const chunk of chunkArray(personIds, 500)) {
    rows.push(
      ...(await admin.query<NotificationAbsenceRow>(
        `
        select
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
          a.tipo_ausencia_nome,
          a.tipo_ausencia_id,
          a.tipo_ausencia_external_id,
          a.lancado_por_nome,
          a.medico,
          c.nome as colaborador_nome,
          c.cargo as colaborador_cargo,
          c.posto as colaborador_posto,
          c.empresa as colaborador_empresa
        from public.atestados a
        inner join public.colaboradores c on c.person_id_nexti = a.person_id_nexti
        where a.person_id_nexti in (${chunk.map((_, index) => `$${index + 1}`).join(", ")})
          and a.removido = false
          and a.eh_atestado_medico = true
          and c.ativo = true
          and c.data_desligamento is null
          and a.data_inicio <= $${chunk.length + 1}
          and a.data_fim >= $${chunk.length + 2}
        order by a.person_id_nexti, a.data_inicio desc
        `,
        [...chunk, windowEnd, windowStart],
      )),
    );
  }

  const grouped = new Map<number, NotificationAbsenceRow[]>();
  for (const row of rows) {
    const current = grouped.get(row.person_id_nexti) ?? [];
    current.push(row);
    grouped.set(row.person_id_nexti, current);
  }

  return Array.from(grouped.entries()).flatMap(([personId, personRows]) => {
    const totalDias = countDistinctDaysInWindow(personRows, windowStart, windowEnd);
    const levels = ALERT_LEVELS.filter((level) => totalDias >= level.threshold);
    if (levels.length === 0) return [];

    const latest = [...personRows].sort((left, right) =>
      compareNullableStringsDesc(left.data_lancamento, right.data_lancamento) || right.id_nexti - left.id_nexti,
    )[0];

    return [{
      personId,
      totalDias,
      windowStart,
      windowEnd,
      row: latest,
      levels,
    }];
  });
}

function buildNewAbsencePayload(row: NotificationAbsenceRow, alert: CurrentAlert | null): NotificationPayload {
  const highestLevel = alert?.levels.at(-1) ?? null;
  const eventKey = `novo_atestado:${row.id_nexti}`;

  return {
    eventType: "novo_atestado",
    eventKey,
    company: row.colaborador_empresa,
    employee: buildEmployeePayload(row),
    absence: buildAbsencePayload(row),
    alert: highestLevel && alert ? buildAlertInfo(alert, highestLevel) : null,
    siteUrl: notificationSiteUrl(),
    createdAt: new Date().toISOString(),
  };
}

function buildAlertPayload(alert: CurrentAlert, level: CurrentAlert["levels"][number]): NotificationPayload {
  const eventKey = `mudanca_nivel_alerta:${alert.personId}:${level.level}`;

  return {
    eventType: "mudanca_nivel_alerta",
    eventKey,
    company: alert.row.colaborador_empresa,
    employee: buildEmployeePayload(alert.row),
    absence: buildAbsencePayload(alert.row),
    alert: buildAlertInfo(alert, level),
    siteUrl: notificationSiteUrl(),
    createdAt: new Date().toISOString(),
  };
}

function buildEmployeePayload(row: NotificationAbsenceRow): NotificationPayload["employee"] {
  return {
    personId: row.person_id_nexti,
    name: row.colaborador_nome,
    matricula: row.matricula,
    cargo: row.colaborador_cargo,
    unidade: row.colaborador_posto,
    empresa: row.colaborador_empresa,
  };
}

function buildAbsencePayload(row: NotificationAbsenceRow): NonNullable<NotificationPayload["absence"]> {
  return {
    idNexti: row.id_nexti,
    startDate: dateOnly(row.data_inicio),
    endDate: dateOnly(row.data_fim),
    days: row.dias,
    launchedAt: row.data_lancamento,
    launchedBy: row.lancado_por_nome ?? row.lancado_por,
    cid: row.cid,
    medico: row.medico,
    observacao: row.observacao,
    tipo: row.tipo_ausencia_nome ?? row.tipo_ausencia_external_id ?? (row.tipo_ausencia_id ? String(row.tipo_ausencia_id) : null),
  };
}

function buildAlertInfo(
  alert: CurrentAlert,
  level: CurrentAlert["levels"][number],
): NonNullable<NotificationPayload["alert"]> {
  const previousLevel = previousAlertLevel(level.level);

  return {
    level: level.level,
    label: level.label,
    previousLevel: previousLevel?.level ?? null,
    previousLabel: previousLevel?.label ?? null,
    totalDias: alert.totalDias,
    threshold: level.threshold,
    windowStart: alert.windowStart,
    windowEnd: alert.windowEnd,
  };
}

function previousAlertLevel(level: CurrentAlert["levels"][number]["level"]): { level: "ok" | "atencao" | "proximo"; label: string } | null {
  if (level === "atencao") return { level: "ok", label: "OK" };
  if (level === "proximo") return { level: "atencao", label: "ATENCAO" };
  if (level === "alerta") return { level: "proximo", label: "PROXIMO DO LIMITE" };
  return null;
}

async function insertNotificationEvent(
  admin: CompatDbClient,
  eventKey: string,
  eventType: NotificationEventType,
  payload: NotificationPayload,
): Promise<number> {
  const result = await admin.query<{ id: string }>(
    `
    insert into public.notification_events (event_key, event_type, payload)
    values ($1, $2, $3::jsonb)
    on conflict (event_key) do nothing
    returning id
    `,
    [eventKey, eventType, JSON.stringify(payload)],
  );

  return result.length;
}

async function dispatchPendingNotificationEvents(admin: CompatDbClient): Promise<{ sent: number; failed: number }> {
  const webhookUrl = env("N8N_WEBHOOK_URL");
  if (!webhookUrl) return { sent: 0, failed: 0 };

  const maxAttempts = Math.max(1, readIntEnv("NOTIFICATION_MAX_ATTEMPTS", 5));
  const events = await admin.query<{
    id: string;
    event_key: string;
    event_type: NotificationEventType;
    payload: NotificationPayload;
    attempts: number;
  }>(
    `
    select id, event_key, event_type, payload, attempts
    from public.notification_events
    where status in ('pendente', 'erro')
      and attempts < $1
    order by created_at asc
    limit 20
    `,
    [maxAttempts],
  );

  let sent = 0;
  let failed = 0;

  for (const event of events) {
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Controle-Secret": env("N8N_WEBHOOK_SECRET") ?? "",
        },
        body: JSON.stringify(event.payload),
      });

      if (!response.ok) {
        const message = await response.text();
        throw new Error(`n8n retornou ${response.status}: ${message.slice(0, 240)}`);
      }

      await admin.query(
        `
        update public.notification_events
        set status = 'enviado',
            attempts = attempts + 1,
            sent_at = now(),
            last_error = null
        where id = $1
        `,
        [event.id],
      );
      sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await admin.query(
        `
        update public.notification_events
        set status = 'erro',
            attempts = attempts + 1,
            last_error = $2
        where id = $1
        `,
        [event.id, message],
      );
      failed += 1;
    }
  }

  return { sent, failed };
}

function countDistinctDaysInWindow(rows: NotificationAbsenceRow[], windowStart: string, windowEnd: string): number {
  const days = new Set<string>();

  for (const row of rows) {
    let cursor = maxDateOnly(dateOnly(row.data_inicio), windowStart);
    const finish = minDateOnly(dateOnly(row.data_fim), windowEnd);

    while (cursor <= finish) {
      days.add(cursor);
      cursor = addDays(cursor, 1);
    }
  }

  return days.size;
}

function notificationSiteUrl(): string {
  return env("NOTIFICATION_SITE_URL") ?? "https://nextibombeiros-bit.github.io/CONTROLE-DE-ATESTADOS/";
}

function uniqueNumbers(values: number[]): number[] {
  return Array.from(new Set(values.filter((value) => Number.isFinite(value))));
}

function dateOnly(value: string): string {
  return value.slice(0, 10);
}

function dateOnlyFromDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function maxDateOnly(left: string, right: string): string {
  return left > right ? left : right;
}

function minDateOnly(left: string, right: string): string {
  return left < right ? left : right;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return dateOnlyFromDate(date);
}

function compareNullableStringsDesc(left: string | null | undefined, right: string | null | undefined): number {
  return (right ?? "").localeCompare(left ?? "");
}

async function refreshExistingAbsenceMetadata(admin: CompatDbClient, situationIndex: SituationIndex) {
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

async function refreshExistingUserNames(admin: CompatDbClient, operatorNames: Map<number, string>) {
  for (const [userId, userName] of operatorNames.entries()) {
    const patch = {
      lancado_por: userName,
      lancado_por_nome: userName,
    };
    const { error } = await admin.from("atestados").update(patch).eq("lancado_por_id", userId);
    if (error) throw new Error(`Erro ao atualizar nomes de usuarios Nexti: ${error.message}`);
  }
}

async function fetchExistingAbsenceIds(admin: CompatDbClient, ids: number[]): Promise<Set<number>> {
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

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function isDismissedPerson(person: NextiPerson): boolean {
  if (person.personSituationId === 3) return true;
  const demissionDate = toDateOnly(person.demissionDate);
  if (!demissionDate) return false;
  return demissionDate <= new Date().toISOString().slice(0, 10);
}

function resolveCompanyLabel(
  company: NextiCompany | null,
  businessUnit: NextiBusinessUnit | null,
  person: NextiPerson,
): string | null {
  const source = firstNonEmpty(company?.fantasyName, company?.companyName, businessUnit?.companyName, person.businessUnitName);
  if (!source) {
    return person.externalCompanyId ?? (isNumber(person.companyId) ? String(person.companyId) : null);
  }

  const normalized = normalizeText(source);
  if (normalized.includes("rb facilities")) return "RB Facilities";
  if (normalized.includes("acaz")) return "Acaz";
  if (normalized.includes("bombeir")) return "Dunamis Bombeiros";
  if (normalized.includes("dunamis") && (normalized.includes("segur") || normalized.includes("vigil"))) {
    return "Dunamis Segurança";
  }
  if (normalized.includes("dunamis") && normalized.includes("servic")) {
    return "Dunamis Serviços";
  }

  return source;
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
