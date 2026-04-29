import type { Atestado, ControleLinha } from "../types";
import { overlapDays, periodLabel } from "./date";
import { statusForDays } from "./status";

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
      const totalDias = sorted.reduce(
        (total, item) => total + overlapDays(item.data_inicio, item.data_fim, periodStart, periodEnd),
        0,
      );
      const colaborador = sorted[0]?.colaboradores;

      return {
        personId,
        status: statusForDays(totalDias),
        totalDias,
        matricula: colaborador?.matricula ?? sorted[0]?.matricula ?? "-",
        colaborador: colaborador?.nome ?? `Colaborador ${personId}`,
        cargo: colaborador?.cargo ?? "-",
        posto: colaborador?.posto ?? "-",
        primeiroAtestado: sorted[0]?.data_inicio ?? periodStart,
        ultimoAtestado: sorted[sorted.length - 1]?.data_fim ?? periodEnd,
        periodo: periodLabel(periodStart, periodEnd),
        atestados: sorted,
      };
    })
    .sort((a, b) => b.totalDias - a.totalDias || a.colaborador.localeCompare(b.colaborador));
}
