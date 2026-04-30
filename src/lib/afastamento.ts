import type { AfastamentoState } from "@/types.ts";

const launchedPatterns = [
  /inss/,
  /rescisao indireta/,
  /auxilio/,
  /beneficio/,
  /afastad/,
];

export function buildAfastamentoInfo(
  cargo: string | null | undefined,
  posto: string | null | undefined,
  totalDias: number,
): {
  afastamentoLancado: boolean;
  afastamentoStatus: AfastamentoState;
  afastamentoLabel: string;
} {
  const source = normalizeComparable([cargo, posto].filter(Boolean).join(" "));
  const afastamentoLancado = launchedPatterns.some((pattern) => pattern.test(source));

  if (afastamentoLancado) {
    return {
      afastamentoLancado: true,
      afastamentoStatus: "lancado",
      afastamentoLabel: totalDias >= 16 ? "Afastamento ja lancado" : "Ja afastado no Nexti",
    };
  }

  if (totalDias >= 16) {
    return {
      afastamentoLancado: false,
      afastamentoStatus: "pendente",
      afastamentoLabel: "16+ sem afastamento",
    };
  }

  return {
    afastamentoLancado: false,
    afastamentoStatus: "monitorando",
    afastamentoLabel: "Sem afastamento",
  };
}

export function normalizeComparable(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}
