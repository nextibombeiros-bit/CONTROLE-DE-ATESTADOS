const DAY_MS = 24 * 60 * 60 * 1000;

export function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function todayInputValue(): string {
  return toDateInputValue(new Date());
}

export function startDateForPreset(days: number): string {
  return toDateInputValue(addDays(new Date(), -(days - 1)));
}

export function formatDateBR(value: string | null | undefined): string {
  if (!value) return "-";
  const [datePart] = value.split("T");
  const [year, month, day] = datePart.split("-");
  if (!year || !month || !day) return value;
  return `${day}/${month}/${year}`;
}

export function formatDateTimeBR(value: string | null | undefined): string {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;

  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(parsed);
}

export function daysBetweenInclusive(start: string, end: string): number {
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  return Math.max(0, Math.floor((endDate.getTime() - startDate.getTime()) / DAY_MS) + 1);
}

export function overlapDays(itemStart: string, itemEnd: string, periodStart: string, periodEnd: string): number {
  const start = itemStart > periodStart ? itemStart : periodStart;
  const end = itemEnd < periodEnd ? itemEnd : periodEnd;
  return daysBetweenInclusive(start, end);
}

export function periodLabel(start: string, end: string): string {
  return `${formatDateBR(start)} a ${formatDateBR(end)}`;
}
