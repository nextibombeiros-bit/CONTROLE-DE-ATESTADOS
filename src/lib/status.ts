import type { StatusKey } from "../types";

export function statusForDays(days: number): StatusKey {
  if (days >= 16) return "alerta";
  if (days >= 12) return "proximo";
  if (days >= 8) return "atencao";
  return "ok";
}

export const statusLabels: Record<StatusKey, string> = {
  alerta: "ALERTA AFASTAMENTO",
  proximo: "PROXIMO DO LIMITE",
  atencao: "ATENCAO",
  ok: "OK",
};
