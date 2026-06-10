import type { Atestado, Sincronizacao } from "@/types.ts";

const configuredApiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "");
const apiBaseUrl = configuredApiBaseUrl ?? "";

export const hasApiConfig = true;

export const apiClient = {
  async fetchAtestados(): Promise<Atestado[]> {
    return request<Atestado[]>("/api/atestados");
  },

  async fetchLatestSync(): Promise<Sincronizacao | null> {
    return request<Sincronizacao | null>("/api/sincronizacoes/latest");
  },

  async syncNexti(): Promise<void> {
    await request("/api/sync-nexti", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ automatic: false }),
    });
  },

  eventsUrl(): string {
    return `${apiBaseUrl}/api/events`;
  },
};

async function request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, init);
  const payload = await readPayload(response);

  if (!response.ok) {
    const message = typeof payload === "object" && payload && "error" in payload
      ? String((payload as { error: unknown }).error)
      : `Erro HTTP ${response.status}`;
    throw new Error(message);
  }

  return payload as T;
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
