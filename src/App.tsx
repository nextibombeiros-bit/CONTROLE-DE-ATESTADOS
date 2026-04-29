import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Eye,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
} from "lucide-react";
import { supabase, hasSupabaseConfig } from "./lib/supabase";
import { buildControle } from "./lib/controle";
import { formatDateBR, periodLabel, startDateForPreset, todayInputValue } from "./lib/date";
import { statusLabels } from "./lib/status";
import type { Atestado, ControleLinha, Sincronizacao, StatusKey } from "./types";

type PeriodMode = "30" | "60" | "90" | "manual";

const summaryConfig: Array<{ key: StatusKey; label: string; icon: typeof AlertTriangle }> = [
  { key: "alerta", label: "Alerta 16+", icon: ShieldAlert },
  { key: "proximo", label: "Proximos do limite", icon: AlertTriangle },
  { key: "atencao", label: "Em atencao", icon: AlertTriangle },
  { key: "ok", label: "OK", icon: CheckCircle2 },
];

function App() {
  const [periodMode, setPeriodMode] = useState<PeriodMode>("60");
  const [startDate, setStartDate] = useState(startDateForPreset(60));
  const [endDate, setEndDate] = useState(todayInputValue());
  const [atestados, setAtestados] = useState<Atestado[]>([]);
  const [syncLog, setSyncLog] = useState<Sincronizacao | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ControleLinha | null>(null);

  useEffect(() => {
    if (periodMode === "manual") return;
    const days = Number(periodMode);
    setStartDate(startDateForPreset(days));
    setEndDate(todayInputValue());
  }, [periodMode]);

  useEffect(() => {
    if (!supabase) return;
    void loadData();
  }, [startDate, endDate]);

  const controle = useMemo(() => buildControle(atestados, startDate, endDate), [atestados, startDate, endDate]);

  const filteredControle = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return controle;
    return controle.filter((line) =>
      [line.matricula, line.colaborador, line.cargo, line.posto].some((value) => value.toLowerCase().includes(term)),
    );
  }, [controle, search]);

  const totals = useMemo(() => {
    return {
      colaboradores: controle.length,
      alerta: controle.filter((line) => line.status === "alerta").length,
      proximo: controle.filter((line) => line.status === "proximo").length,
      atencao: controle.filter((line) => line.status === "atencao").length,
      ok: controle.filter((line) => line.status === "ok").length,
    };
  }, [controle]);

  async function loadData() {
    if (!supabase) return;
    setLoading(true);
    setError("");

    const [{ data: atestadosData, error: atestadosError }, { data: syncData }] = await Promise.all([
      supabase
        .from("atestados")
        .select("*, colaboradores(*)")
        .eq("removido", false)
        .lte("data_inicio", endDate)
        .gte("data_fim", startDate)
        .order("data_inicio", { ascending: false }),
      supabase
        .from("sincronizacoes")
        .select("*")
        .order("iniciado_em", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (atestadosError) {
      setError(atestadosError.message);
    } else {
      setAtestados((atestadosData ?? []) as Atestado[]);
      setSyncLog((syncData as Sincronizacao | null) ?? null);
    }

    setLoading(false);
  }

  async function syncNexti() {
    if (!supabase) return;
    setSyncing(true);
    setError("");

    const { error: syncError } = await supabase.functions.invoke("sync-nexti", {
      body: {
        startLastUpdate: `${startDate}T00:00:00`,
        finishLastUpdate: `${endDate}T23:59:59`,
      },
    });

    if (syncError) {
      setError(syncError.message);
    } else {
      await loadData();
    }

    setSyncing(false);
  }

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
        <div className="topbar-actions">
          <button className="icon-button" type="button" onClick={syncNexti} disabled={syncing} title="Sincronizar Nexti">
            {syncing ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            Sincronizar
          </button>
        </div>
      </header>

      <section className="toolbar">
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
        <label className="search-field">
          <Search size={16} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar" />
        </label>
      </section>

      {error ? <div className="notice error">{error}</div> : null}

      <section className="summary-grid">
        <article className="summary-card">
          <span>Total no periodo</span>
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

      <section className="table-section">
        <div className="section-heading">
          <div>
            <h2>Controle</h2>
            <p>
              {loading ? "Carregando dados..." : `${filteredControle.length} colaboradores encontrados`}
              {syncLog ? ` | Ultima sincronizacao: ${formatDateBR(syncLog.iniciado_em)}` : ""}
            </p>
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
                <th>Primeiro</th>
                <th>Ultimo</th>
                <th>Periodo</th>
                <th aria-label="Historico"></th>
              </tr>
            </thead>
            <tbody>
              {filteredControle.map((line) => (
                <tr key={line.personId}>
                  <td>
                    <span className={`status-pill ${line.status}`}>{statusLabels[line.status]}</span>
                  </td>
                  <td className="days">{line.totalDias}</td>
                  <td>{line.matricula}</td>
                  <td>{line.colaborador}</td>
                  <td>{line.cargo}</td>
                  <td>{line.posto}</td>
                  <td>{formatDateBR(line.primeiroAtestado)}</td>
                  <td>{formatDateBR(line.ultimoAtestado)}</td>
                  <td>{line.periodo}</td>
                  <td>
                    <button className="table-action" type="button" onClick={() => setSelected(line)} title="Ver historico">
                      <Eye size={16} />
                    </button>
                  </td>
                </tr>
              ))}
              {!loading && filteredControle.length === 0 ? (
                <tr>
                  <td colSpan={10} className="empty-state">
                    Nenhum atestado encontrado no periodo.
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
                    <th>Tipo</th>
                    <th>ID Nexti</th>
                    <th>Observacao</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.atestados.map((item) => (
                    <tr key={item.id}>
                      <td>{formatDateBR(item.data_inicio)}</td>
                      <td>{formatDateBR(item.data_fim)}</td>
                      <td className="days">{item.dias}</td>
                      <td>{formatDateBR(item.data_lancamento)}</td>
                      <td>{item.lancado_por ?? "-"}</td>
                      <td>{item.cid ?? "-"}</td>
                      <td>{item.tipo_ausencia_id ?? item.tipo_ausencia_external_id ?? "-"}</td>
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
