import type { Atestado, ControleLinha, DateFilterMode, HistoricoAlertaLinha } from "@/types.ts";
import { buildAfastamentoInfo } from "@/lib/afastamento.ts";
import { periodLabel } from "@/lib/date.ts";
import { statusForDays } from "@/lib/status.ts";

const ROLLING_WINDOW_DAYS = 60;
const ALERT_THRESHOLD_DAYS = 16;

export function buildControle(
  atestados: Atestado[],
  periodStart: string,
  periodEnd: string,
  dateFilterMode: DateFilterMode = "periodo_atestado",
): ControleLinha[] {
  return Array.from(groupAtestadosByPerson(atestados).entries())
    .map(([personId, items]) => {
      const sorted = sortAtestados(items);
      const atestadosNoPeriodo = sorted.filter((item) => matchesDateFilter(item, periodStart, periodEnd, dateFilterMode));

      if (atestadosNoPeriodo.length === 0) {
        return null;
      }

      const ranges = atestadosNoPeriodo.map((item) => ({ start: item.data_inicio, end: item.data_fim }));
      const mergedRanges = mergeRanges(ranges);
      const totalDias = atestadosNoPeriodo.reduce((total, item) => total + item.dias, 0);
      if (totalDias <= 0) {
        return null;
      }

      const colaborador = sorted[0]?.colaboradores;
      const afastamento = buildAfastamentoInfo(colaborador?.cargo, colaborador?.posto, totalDias);
      const primeiroAtestado = mergedRanges[0]?.start ?? atestadosNoPeriodo[0].data_inicio;
      const ultimoAtestado = mergedRanges[mergedRanges.length - 1]?.end ?? atestadosNoPeriodo[atestadosNoPeriodo.length - 1].data_fim;

      return {
        personId,
        status: statusForDays(totalDias),
        ...afastamento,
        totalDias,
        matricula: colaborador?.matricula ?? sorted[0]?.matricula ?? "-",
        colaborador: colaborador?.nome ?? `Colaborador ${personId}`,
        cargo: colaborador?.cargo ?? "-",
        posto: colaborador?.posto ?? "-",
        empresa: colaborador?.empresa ?? "-",
        primeiroAtestado,
        ultimoAtestado,
        ultimoLancamento: latestLaunchDate(atestadosNoPeriodo),
        periodo: periodLabel(periodStart, periodEnd),
        atestados: atestadosNoPeriodo,
      } satisfies ControleLinha;
    })
    .filter((line): line is ControleLinha => line !== null)
    .sort((a, b) => b.totalDias - a.totalDias || a.colaborador.localeCompare(b.colaborador));
}

export function buildHistoricoAlertas(atestados: Atestado[]): HistoricoAlertaLinha[] {
  return Array.from(groupAtestadosByPerson(atestados).entries())
    .map(([personId, items]) => {
      const sorted = sortAtestados(items);
      const mergedRanges = mergeRanges(sorted.map((item) => ({ start: item.data_inicio, end: item.data_fim })));
      const coveredDays = expandRangesToDays(mergedRanges);
      const peakWindow = findPeakRollingWindow(coveredDays, ROLLING_WINDOW_DAYS);

      if (!peakWindow || peakWindow.totalDias < ALERT_THRESHOLD_DAYS) {
        return null;
      }

      const colaborador = sorted[0]?.colaboradores;
      const janelaCriticaInicio = peakWindow.start;
      const janelaCriticaFim = peakWindow.end;
      const atestadosDaJanela = sorted.filter((item) => overlapsPeriod(item, janelaCriticaInicio, janelaCriticaFim));
      const afastamento = buildAfastamentoInfo(colaborador?.cargo, colaborador?.posto, peakWindow.totalDias);

      return {
        personId,
        status: statusForDays(peakWindow.totalDias),
        ...afastamento,
        totalDias: peakWindow.totalDias,
        matricula: colaborador?.matricula ?? sorted[0]?.matricula ?? "-",
        colaborador: colaborador?.nome ?? `Colaborador ${personId}`,
        cargo: colaborador?.cargo ?? "-",
        posto: colaborador?.posto ?? "-",
        empresa: colaborador?.empresa ?? "-",
        primeiroAtestado: peakWindow.firstCoveredDay,
        ultimoAtestado: peakWindow.lastCoveredDay,
        ultimoLancamento: latestLaunchDate(atestadosDaJanela),
        periodo: periodLabel(janelaCriticaInicio, janelaCriticaFim),
        janelaCriticaInicio,
        janelaCriticaFim,
        atestados: atestadosDaJanela,
      } satisfies HistoricoAlertaLinha;
    })
    .filter((line): line is HistoricoAlertaLinha => line !== null)
    .sort((a, b) => b.totalDias - a.totalDias || a.colaborador.localeCompare(b.colaborador));
}

function groupAtestadosByPerson(atestados: Atestado[]): Map<number, Atestado[]> {
  const grouped = new Map<number, Atestado[]>();

  for (const atestado of atestados) {
    const current = grouped.get(atestado.person_id_nexti) ?? [];
    current.push(atestado);
    grouped.set(atestado.person_id_nexti, current);
  }

  return grouped;
}

function sortAtestados(items: Atestado[]): Atestado[] {
  return [...items].sort(
    (a, b) =>
      a.data_inicio.localeCompare(b.data_inicio) ||
      a.data_fim.localeCompare(b.data_fim) ||
      a.id_nexti - b.id_nexti,
  );
}

function overlapsPeriod(item: Atestado, periodStart: string, periodEnd: string): boolean {
  return item.data_inicio <= periodEnd && item.data_fim >= periodStart;
}

export function matchesDateFilter(
  item: Atestado,
  periodStart: string,
  periodEnd: string,
  dateFilterMode: DateFilterMode,
): boolean {
  if (dateFilterMode === "data_lancamento") {
    const launchDate = dateOnly(item.data_lancamento);
    return Boolean(launchDate && launchDate >= periodStart && launchDate <= periodEnd);
  }

  return overlapsPeriod(item, periodStart, periodEnd);
}

function latestLaunchDate(items: Atestado[]): string | null {
  return items.reduce<string | null>((latest, item) => {
    const launchDate = dateOnly(item.data_lancamento);
    if (!launchDate) return latest;
    return !latest || launchDate > latest ? launchDate : latest;
  }, null);
}

function dateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  const [datePart] = value.split("T");
  return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : null;
}

function mergeRanges(ranges: Array<{ start: string; end: string }>): Array<{ start: string; end: string }> {
  if (ranges.length === 0) return [];

  const sorted = [...ranges].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const merged: Array<{ start: string; end: string }> = [{ ...sorted[0] }];

  for (const current of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    const nextDayAfterLast = addOneDay(last.end);

    if (current.start <= nextDayAfterLast) {
      if (current.end > last.end) {
        last.end = current.end;
      }
      continue;
    }

    merged.push({ ...current });
  }

  return merged;
}

function expandRangesToDays(ranges: Array<{ start: string; end: string }>): string[] {
  const days: string[] = [];

  for (const range of ranges) {
    let current = range.start;
    while (current <= range.end) {
      days.push(current);
      current = addOneDay(current);
    }
  }

  return days;
}

function findPeakRollingWindow(
  coveredDays: string[],
  windowDays: number,
): { start: string; end: string; firstCoveredDay: string; lastCoveredDay: string; totalDias: number } | null {
  if (coveredDays.length === 0) return null;

  let left = 0;
  let best = {
    start: coveredDays[0],
    end: addDays(coveredDays[0], windowDays - 1),
    firstCoveredDay: coveredDays[0],
    lastCoveredDay: coveredDays[0],
    totalDias: 1,
  };

  for (let right = 0; right < coveredDays.length; right += 1) {
    while (differenceInDays(coveredDays[left], coveredDays[right]) >= windowDays) {
      left += 1;
    }

    const totalDias = right - left + 1;
    const start = coveredDays[left];
    const candidate = {
      start,
      end: addDays(start, windowDays - 1),
      firstCoveredDay: coveredDays[left],
      lastCoveredDay: coveredDays[right],
      totalDias,
    };

    if (candidate.totalDias > best.totalDias) {
      best = candidate;
      continue;
    }

    if (candidate.totalDias === best.totalDias && candidate.start < best.start) {
      best = candidate;
    }
  }

  return best;
}

function differenceInDays(start: string, end: string): number {
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  return Math.floor((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
}

function addOneDay(value: string): string {
  return addDays(value, 1);
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
