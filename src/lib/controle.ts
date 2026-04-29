import type { Atestado, ControleLinha } from "@/types.ts";
import { daysBetweenInclusive, periodLabel } from "@/lib/date.ts";
import { statusForDays } from "@/lib/status.ts";

export function buildControle(atestados: Atestado[], periodStart: string, periodEnd: string): ControleLinha[] {
  const grouped = new Map<number, Atestado[]>();

  for (const atestado of atestados) {
    const current = grouped.get(atestado.person_id_nexti) ?? [];
    current.push(atestado);
    grouped.set(atestado.person_id_nexti, current);
  }

  return Array.from(grouped.entries())
    .map(([personId, items]) => {
      const sorted = [...items].sort((a, b) => a.data_inicio.localeCompare(b.data_inicio));
      const ranges = sorted
        .map((item) => clampRange(item.data_inicio, item.data_fim, periodStart, periodEnd))
        .filter((value): value is { start: string; end: string } => value !== null);
      const mergedRanges = mergeRanges(ranges);
      const totalDias = mergedRanges.reduce((total, range) => total + daysBetweenInclusive(range.start, range.end), 0);
      const colaborador = sorted[0]?.colaboradores;
      const primeiroAtestado = mergedRanges[0]?.start ?? periodStart;
      const ultimoAtestado = mergedRanges[mergedRanges.length - 1]?.end ?? periodEnd;

      return {
        personId,
        status: statusForDays(totalDias),
        totalDias,
        matricula: colaborador?.matricula ?? sorted[0]?.matricula ?? "-",
        colaborador: colaborador?.nome ?? `Colaborador ${personId}`,
        cargo: colaborador?.cargo ?? "-",
        posto: colaborador?.posto ?? "-",
        primeiroAtestado,
        ultimoAtestado,
        periodo: periodLabel(periodStart, periodEnd),
        atestados: sorted,
      };
    })
    .sort((a, b) => b.totalDias - a.totalDias || a.colaborador.localeCompare(b.colaborador));
}

function clampRange(
  itemStart: string,
  itemEnd: string,
  periodStart: string,
  periodEnd: string,
): { start: string; end: string } | null {
  const start = itemStart > periodStart ? itemStart : periodStart;
  const end = itemEnd < periodEnd ? itemEnd : periodEnd;
  return start <= end ? { start, end } : null;
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

function addOneDay(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() + 1);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
