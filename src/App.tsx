import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Eye,
  Search,
  ShieldAlert,
} from "lucide-react";
import { supabase, hasSupabaseConfig } from "@/lib/supabase.ts";
import { buildControle, buildHistoricoAlertas } from "@/lib/controle.ts";
import {
  formatDateBR,
  periodLabel,
  startDateForPreset,
  todayInputValue,
} from "@/lib/date.ts";
import { statusLabels } from "@/lib/status.ts";
import type { Atestado, ControleLinha, HistoricoAlertaLinha, Sincronizacao, StatusKey } from "@/types.ts";

type PeriodMode = "30" | "60" | "90" | "manual";
type ViewMode = "controle" | "historico";
type LinhaSelecionavel = ControleLinha | HistoricoAlertaLinha;

const AUTO_SYNC_STALE_MS = 10 * 60 * 1000;
const AUTO_SYNC_COOLDOWN_MS = 60 * 1000;
const PAGE_SIZE = 1000;

const summaryConfig: Array<{ key: StatusKey; label: string; icon: typeof AlertTriangle }> = [
  { key: "alerta", label: "Alerta 16+", icon: ShieldAlert },
  { key: "proximo", label: "Proximos do limite", icon: AlertTriangle },
  { key: "atencao", label: "Em atencao", icon: AlertTriangle },
  { key: "ok", label: "OK", icon: CheckCircle2 },
];

function App() {
  const [viewMode, setViewMode] = useState<ViewMode>("controle");
  const [periodMode, setPeriodMode] = useState<PeriodMode>("60");
  const [startDate, setStartDate] = useState(startDateForPreset(60));
  const [endDate, setEndDate] = useState(todayInputValue());
  const [atestados, setAtestados] = useState<Atestado[]>([]);
  const [syncLog, setSyncLog] = useState<Sincronizacao | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<LinhaSelecionavel | null>(null);
  const reloadTimerRef = useRef<number | null>(null);
  const lastAutoSyncRequestRef = useRef(0);

  useEffect(() => {
    if (periodMode === "manual") return;
    const days = Number(periodMode);
    setStartDate(startDateForPreset(days));
    setEndDate(todayInputValue());
  }, [periodMode]);

  async function loadData() {
    if (!supabase) return;
    setLoading(true);
    setError("");

    const [{ data: atestadosData, error: atestadosError }, { data: syncData, error: syncError }] = await Promise.all([
      fetchAllAtestados(),
      supabase.from("sincronizacoes").select("*").order("iniciado_em", { ascending: false }).limit(1).maybeSingle(),
    ]);

    if (atestadosError) {
      setError(atestadosError.message);
    } else if (syncError) {
      setError(syncError.message);
    } else {
      const latestSync = (syncData as Sincronizacao | null) ?? null;
      setAtestados((atestadosData ?? []) as Atestado[]);
      setSyncLog(latestSync);
      if (latestSync?.status === "erro" && latestSync.erro) {
        setError(`Falha na ultima sincronizacao automatica: ${latestSync.erro}`);
      }
    }

    setLoading(false);
  }

  async function syncNexti() {
    if (!supabase) return;
    setSyncing(true);
    setError("");

    const { error: syncError } = await supabase.functions.invoke("sync-nexti", {
      body: {
        automatic: true,
      },
    });

    if (syncError) {
      setError(syncError.message);
    } else {
      await loadData();
    }

    setSyncing(false);
  }

  useEffect(() => {
    if (!supabase) return;
    void loadData();
  }, []);

  useEffect(() => {
    const client = supabase;
    if (!client) return;

    const scheduleReload = () => {
      if (reloadTimerRef.current) {
        window.clearTimeout(reloadTimerRef.current);
      }

      reloadTimerRef.current = window.setTimeout(() => {
        void loadData();
      }, 800);
    };

    const channel = client
      .channel("controle-atestados-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "atestados" }, scheduleReload)
      .on("postgres_changes", { event: "*", schema: "public", table: "colaboradores" }, scheduleReload)
      .on("postgres_changes", { event: "*", schema: "public", table: "sincronizacoes" }, scheduleReload)
      .subscribe();

    const intervalId = window.setInterval(() => {
      void loadData();
    }, 60_000);

    return () => {
      window.clearInterval(intervalId);
      if (reloadTimerRef.current) {
        window.clearTimeout(reloadTimerRef.current);
      }
      void client.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    if (!supabase || syncing) return;

    const latestSyncReference = syncLog?.finalizado_em ?? syncLog?.iniciado_em ?? null;
    const ageMs = latestSyncReference
      ? Date.now() - new Date(latestSyncReference).getTime()
      : Number.POSITIVE_INFINITY;
    const cooldownElapsed = Date.now() - lastAutoSyncRequestRef.current > AUTO_SYNC_COOLDOWN_MS;

    if (!cooldownElapsed) return;

    if (!syncLog || (syncLog.status !== "em_execucao" && ageMs > AUTO_SYNC_STALE_MS)) {
      lastAutoSyncRequestRef.current = Date.now();
      void syncNexti();
    }
  }, [syncLog, syncing]);

  const controle = useMemo(() => buildControle(atestados, startDate, endDate), [atestados, startDate, endDate]);
  const historicoAlertas = useMemo(() => buildHistoricoAlertas(atestados), [atestados]);

  const filteredControle = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return controle;
    return controle.filter((line) =>
      [line.matricula, line.colaborador, line.cargo, line.posto, line.empresa].some((value) =>
        value.toLowerCase().includes(term),
      ),
    );
  }, [controle, search]);

  const filteredHistorico = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return historicoAlertas;
    return historicoAlertas.filter((line) =>
      [line.matricula, line.colaborador, line.cargo, line.posto, line.empresa].some((value) =>
        value.toLowerCase().includes(term),
      ),
    );
  }, [historicoAlertas, search]);

  const totals = useMemo(() => {
    return {
      colaboradores: controle.length,
      alerta: controle.filter((line) => line.status === "alerta").length,
      proximo: controle.filter((line) => line.status === "proximo").length,
      atencao: controle.filter((line) => line.status === "atencao").length,
      ok: controle.filter((line) => line.status === "ok").length,
    };
  }, [controle]);

  const historicoTotals = useMemo(() => {
    return {
      colaboradores: historicoAlertas.length,
      maiorPico: historicoAlertas[0]?.totalDias ?? 0,
      empresas: new Set(historicoAlertas.map((line) => line.empresa).filter((value) => value && value !== "-")).size,
    };
  }, [historicoAlertas]);

  const linhasVisiveis = viewMode === "controle" ? filteredControle : filteredHistorico;

  const historicoSelecionado = useMemo(() => {
    if (!selected) return [];
    return [...selected.atestados].sort(
      (a, b) => b.data_inicio.localeCompare(a.data_inicio) || b.id_nexti - a.id_nexti,
    );
  }, [selected]);

  if (!hasSupabaseConfig) {
    return (
      <main className="auth-layout">
        <section className="auth-panel">
          <ShieldAlert size={32} />
          <h1>Controle de Atestados</h1>
          <p>Configure `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` no ambiente do frontend.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">RH / DP</p>
          <h1>Controle de Atestados</h1>
        </div>
      </header>

      <section className="toolbar">
        <div className="view-switch" aria-label="Visao">
          <button
            type="button"
            className={viewMode === "controle" ? "active" : ""}
            onClick={() => setViewMode("controle")}
          >
            Controle atual
          </button>
          <button
            type="button"
            className={viewMode === "historico" ? "active" : ""}
            onClick={() => setViewMode("historico")}
          >
            Historico 16+ / 60 dias
          </button>
        </div>

        {viewMode === "controle" ? (
          <>
            <div className="segmented" aria-label="Periodo">
              {(["30", "60", "90"] as PeriodMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={periodMode === mode ? "active" : ""}
                  onClick={() => setPeriodMode(mode)}
                >
                  {mode} dias
                </button>
              ))}
              <button
                type="button"
                className={periodMode === "manual" ? "active" : ""}
                onClick={() => setPeriodMode("manual")}
              >
                Manual
              </button>
            </div>
            <label className="date-field">
              <CalendarDays size={16} />
              <input
                type="date"
                value={startDate}
                onChange={(event) => {
                  setPeriodMode("manual");
                  setStartDate(event.target.value);
                }}
              />
            </label>
            <label className="date-field">
              <CalendarDays size={16} />
              <input
                type="date"
                value={endDate}
                onChange={(event) => {
                  setPeriodMode("manual");
                  setEndDate(event.target.value);
                }}
              />
            </label>
          </>
        ) : null}

        <label className="search-field">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar matricula, nome, cargo, posto ou empresa"
          />
        </label>
      </section>

      {error ? <div className="notice error">{error}</div> : null}

      {viewMode === "controle" ? (
        <section className="summary-grid">
          <article className="summary-card">
            <span>Total com atestado medico</span>
            <strong>{totals.colaboradores}</strong>
            <small>{periodLabel(startDate, endDate)}</small>
          </article>
          {summaryConfig.slice(0, 3).map(({ key, label, icon: Icon }) => (
            <article className={`summary-card ${key}`} key={key}>
              <span>{label}</span>
              <strong>{totals[key]}</strong>
              <Icon size={20} />
            </article>
          ))}
        </section>
      ) : (
        <section className="summary-grid summary-grid-historico">
          <article className="summary-card alerta">
            <span>Ativos com historico 16+</span>
            <strong>{historicoTotals.colaboradores}</strong>
            <small>Em qualquer janela movel de 60 dias</small>
          </article>
          <article className="summary-card">
            <span>Maior pico em 60 dias</span>
            <strong>{historicoTotals.maiorPico}</strong>
            <small>Dias distintos de atestado</small>
          </article>
          <article className="summary-card">
            <span>Empresas afetadas</span>
            <strong>{historicoTotals.empresas}</strong>
            <small>Dunamis, RB Facilities e Acaz</small>
          </article>
        </section>
      )}

      <section className="table-section">
        <div className="section-heading">
          <div>
            <h2>{viewMode === "controle" ? "Controle" : "Historico 16+ em 60 dias"}</h2>
            <p>{loading ? "Carregando dados..." : `${linhasVisiveis.length} colaboradores encontrados`}</p>
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Dias</th>
                <th>Matricula</th>
                <th>Colaborador</th>
                <th>Cargo</th>
                <th>Posto</th>
                <th>Empresa</th>
                <th>Primeiro</th>
                <th>Ultimo</th>
                <th>Periodo</th>
              </tr>
            </thead>
            <tbody>
              {linhasVisiveis.map((line) => (
                <tr key={line.personId}>
                  <td>
                    <span className={`status-pill ${line.status}`}>{statusLabels[line.status]}</span>
                  </td>
                  <td className="days">{line.totalDias}</td>
                  <td>{line.matricula}</td>
                  <td>
                    <button className="colaborador-link" type="button" onClick={() => setSelected(line)}>
                      <span>{line.colaborador}</span>
                      <Eye size={14} />
                    </button>
                  </td>
                  <td>{line.cargo}</td>
                  <td>{line.posto}</td>
                  <td>{line.empresa}</td>
                  <td>{formatDateBR(line.primeiroAtestado)}</td>
                  <td>{formatDateBR(line.ultimoAtestado)}</td>
                  <td>{line.periodo}</td>
                </tr>
              ))}
              {!loading && linhasVisiveis.length === 0 ? (
                <tr>
                  <td colSpan={10} className="empty-state">
                    {viewMode === "controle"
                      ? "Nenhum atestado medico encontrado no periodo."
                      : "Nenhum colaborador ativo atingiu 16 dias em uma janela de 60 dias."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {selected ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setSelected(null)}>
          <section className="modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <p className="eyebrow">{selected.matricula}</p>
                <h2>{selected.colaborador}</h2>
                <p className="muted">
                  {selected.cargo} | {selected.posto} | {selected.empresa}
                </p>
                {isHistoricoLinha(selected) ? (
                  <p className="muted">Janela critica: {selected.periodo}</p>
                ) : null}
              </div>
              <button className="icon-only" type="button" onClick={() => setSelected(null)} aria-label="Fechar">
                x
              </button>
            </div>
            <div className="table-wrap compact">
              <table>
                <thead>
                  <tr>
                    <th>Inicio</th>
                    <th>Fim</th>
                    <th>Dias</th>
                    <th>Lancamento</th>
                    <th>Lancado por</th>
                    <th>CID</th>
                    <th>Medico</th>
                    <th>Tipo</th>
                    <th>ID Nexti</th>
                    <th>Observacao</th>
                  </tr>
                </thead>
                <tbody>
                  {historicoSelecionado.map((item) => (
                    <tr key={item.id}>
                      <td>{formatDateBR(item.data_inicio)}</td>
                      <td>{formatDateBR(item.data_fim)}</td>
                      <td className="days">{item.dias}</td>
                      <td>{item.data_lancamento ? new Date(item.data_lancamento).toLocaleString("pt-BR") : "-"}</td>
                      <td>{formatLancadoPor(item)}</td>
                      <td>{item.cid ?? "-"}</td>
                      <td>{item.medico ?? "-"}</td>
                      <td>{item.tipo_ausencia_nome ?? item.tipo_ausencia_id ?? item.tipo_ausencia_external_id ?? "-"}</td>
                      <td>{item.id_nexti}</td>
                      <td>{item.observacao ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

export default App;

function isHistoricoLinha(line: LinhaSelecionavel): line is HistoricoAlertaLinha {
  return "janelaCriticaInicio" in line && "janelaCriticaFim" in line;
}

function formatLancadoPor(item: Atestado): string {
  if (item.lancado_por_nome) return item.lancado_por_nome;
  if (item.lancado_por && /\D/.test(item.lancado_por)) return item.lancado_por;
  if (typeof item.lancado_por_id === "number") return `Operador Nexti ${item.lancado_por_id}`;
  return item.lancado_por ?? "-";
}

async function fetchAllAtestados(): Promise<{ data: Atestado[] | null; error: Error | null }> {
  if (!supabase) {
    return { data: null, error: new Error("Supabase nao configurado") };
  }

  const rows: Atestado[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("atestados")
      .select("*, colaboradores!inner(*)")
      .eq("removido", false)
      .eq("eh_atestado_medico", true)
      .eq("colaboradores.ativo", true)
      .order("data_inicio", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      return { data: null, error: new Error(error.message) };
    }

    const chunk = ((data ?? []) as Atestado[]);
    rows.push(...chunk);

    if (chunk.length < PAGE_SIZE) {
      break;
    }

    from += PAGE_SIZE;
  }

  return { data: rows, error: null };
}
