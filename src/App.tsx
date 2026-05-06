import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  AlertTriangle,
  BarChart3,
  Building2,
  CalendarDays,
  CheckCircle2,
  Download,
  Eye,
  Filter,
  RefreshCw,
  Search,
  ShieldAlert,
  Users,
} from "lucide-react";
import { supabase, hasSupabaseConfig } from "@/lib/supabase.ts";
import { buildControle, buildHistoricoAlertas, matchesDateFilter } from "@/lib/controle.ts";
import { normalizeComparable } from "@/lib/afastamento.ts";
import {
  formatDateBR,
  formatDateTimeBR,
  periodLabel,
  startDateForPreset,
  todayInputValue,
} from "@/lib/date.ts";
import { statusLabels } from "@/lib/status.ts";
import type {
  AfastamentoState,
  Atestado,
  ControleLinha,
  DateFilterMode,
  HistoricoAlertaLinha,
  Sincronizacao,
  StatusKey,
} from "@/types.ts";

type PeriodMode = "30" | "60" | "90" | "manual";
type PageMode = "painel" | "relatorios";
type ViewMode = "controle" | "historico";
type LinhaSelecionavel = ControleLinha | HistoricoAlertaLinha;
type StatusFilter = "todos" | StatusKey;
type AfastamentoFilter = "todos" | "ocultar_lancados" | "somente_lancados" | "somente_pendentes";
type SortOption =
  | "dias_desc"
  | "dias_asc"
  | "nome_asc"
  | "empresa_asc"
  | "posto_asc"
  | "primeiro_desc"
  | "ultimo_desc"
  | "lancamento_desc";
type RankingItem = {
  label: string;
  totalDias: number;
  colaboradores: number;
  afastados: number;
};
type MonthlyPoint = {
  key: string;
  label: string;
  totalDias: number;
  colaboradores: number;
};
type OperadorSelecionado = {
  id: number;
  nome: string;
};

const PAGE_SIZE = 1000;

const summaryConfig: Array<{ key: StatusKey; label: string; icon: typeof AlertTriangle }> = [
  { key: "alerta", label: "Alerta 16+", icon: ShieldAlert },
  { key: "proximo", label: "Proximos do limite", icon: AlertTriangle },
  { key: "atencao", label: "Em atencao", icon: AlertTriangle },
  { key: "ok", label: "OK", icon: CheckCircle2 },
];

const sortOptions: Array<{ value: SortOption; label: string }> = [
  { value: "dias_desc", label: "Maior total de dias" },
  { value: "dias_asc", label: "Menor total de dias" },
  { value: "nome_asc", label: "Colaborador A-Z" },
  { value: "empresa_asc", label: "Empresa A-Z" },
  { value: "posto_asc", label: "Unidade / posto A-Z" },
  { value: "primeiro_desc", label: "Primeiro atestado mais recente" },
  { value: "ultimo_desc", label: "Ultimo atestado mais recente" },
  { value: "lancamento_desc", label: "Lancamento mais recente" },
];

function App() {
  const [pageMode, setPageMode] = useState<PageMode>("painel");
  const [viewMode, setViewMode] = useState<ViewMode>("controle");
  const [periodMode, setPeriodMode] = useState<PeriodMode>("60");
  const [startDate, setStartDate] = useState(startDateForPreset(60));
  const [endDate, setEndDate] = useState(todayInputValue());
  const [dateFilterMode, setDateFilterMode] = useState<DateFilterMode>("periodo_atestado");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("todos");
  const [afastamentoFilter, setAfastamentoFilter] = useState<AfastamentoFilter>("todos");
  const [empresaFilter, setEmpresaFilter] = useState("todas");
  const [unidadeFilter, setUnidadeFilter] = useState("todas");
  const [sortOption, setSortOption] = useState<SortOption>("dias_desc");
  const [atestados, setAtestados] = useState<Atestado[]>([]);
  const [syncLog, setSyncLog] = useState<Sincronizacao | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<LinhaSelecionavel | null>(null);
  const [operadorSelecionado, setOperadorSelecionado] = useState<OperadorSelecionado | null>(null);
  const [tableScrollWidth, setTableScrollWidth] = useState(0);
  const [tableClientWidth, setTableClientWidth] = useState(0);
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const tableTopScrollRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const topScrollDragRef = useRef<{ pointerId: number; startX: number; startScrollLeft: number } | null>(null);

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
        setError(`Falha na ultima sincronizacao: ${latestSync.erro}`);
      }
    }

    setLoading(false);
  }

  async function syncNexti() {
    if (!supabase || syncing) return;
    setSyncing(true);
    setError("");

    const { error: syncError } = await supabase.functions.invoke("sync-nexti", {
      body: {
        automatic: false,
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

  const controle = useMemo(
    () => buildControle(atestados, startDate, endDate, dateFilterMode),
    [atestados, dateFilterMode, endDate, startDate],
  );
  const historicoAlertas = useMemo(() => buildHistoricoAlertas(atestados), [atestados]);
  const linhasBase = viewMode === "controle" ? controle : historicoAlertas;

  const empresaOptions = useMemo(() => uniqueOptions(linhasBase.map((line) => line.empresa)), [linhasBase]);
  const unidadeOptions = useMemo(() => uniqueOptions(linhasBase.map((line) => line.posto)), [linhasBase]);

  const linhasContexto = useMemo(() => {
    const term = normalizeComparable(search);
    return linhasBase.filter((line) => {
      if (empresaFilter !== "todas" && line.empresa !== empresaFilter) return false;
      if (unidadeFilter !== "todas" && line.posto !== unidadeFilter) return false;

      if (afastamentoFilter === "ocultar_lancados" && line.afastamentoLancado) return false;
      if (afastamentoFilter === "somente_lancados" && !line.afastamentoLancado) return false;
      if (afastamentoFilter === "somente_pendentes" && line.afastamentoStatus !== "pendente") return false;

      if (!term) return true;

      return [
        line.matricula,
        line.colaborador,
        line.cargo,
        line.posto,
        line.empresa,
        line.afastamentoLabel,
      ].some((value) => normalizeComparable(value).includes(term));
    });
  }, [afastamentoFilter, empresaFilter, linhasBase, search, unidadeFilter]);

  const linhasVisiveis = useMemo(() => {
    const filtradas = statusFilter === "todos"
      ? linhasContexto
      : linhasContexto.filter((line) => line.status === statusFilter);
    return sortLinhas(filtradas, sortOption);
  }, [linhasContexto, sortOption, statusFilter]);

  const controleTotals = useMemo(() => {
    return {
      colaboradores: linhasContexto.length,
      alerta: linhasContexto.filter((line) => line.status === "alerta").length,
      proximo: linhasContexto.filter((line) => line.status === "proximo").length,
      atencao: linhasContexto.filter((line) => line.status === "atencao").length,
      ok: linhasContexto.filter((line) => line.status === "ok").length,
      lancados: linhasContexto.filter((line) => line.afastamentoLancado).length,
      pendentes: linhasContexto.filter((line) => line.afastamentoStatus === "pendente").length,
    };
  }, [linhasContexto]);

  const historicoTotals = useMemo(() => {
    return {
      colaboradores: linhasContexto.length,
      lancados: linhasContexto.filter((line) => line.afastamentoLancado).length,
      pendentes: linhasContexto.filter((line) => line.afastamentoStatus === "pendente").length,
      maiorPico: linhasContexto[0]?.totalDias ?? 0,
      empresas: new Set(linhasContexto.map((line) => line.empresa).filter((value) => value && value !== "-")).size,
    };
  }, [linhasContexto]);

  const reportTotals = useMemo(() => {
    return {
      colaboradores: linhasVisiveis.length,
      totalDias: linhasVisiveis.reduce((sum, line) => sum + line.totalDias, 0),
      lancados: linhasVisiveis.filter((line) => line.afastamentoLancado).length,
      pendentes: linhasVisiveis.filter((line) => line.afastamentoStatus === "pendente").length,
      empresas: new Set(linhasVisiveis.map((line) => line.empresa).filter((value) => value && value !== "-")).size,
      unidades: new Set(linhasVisiveis.map((line) => line.posto).filter((value) => value && value !== "-")).size,
    };
  }, [linhasVisiveis]);

  const personIdsVisiveis = useMemo(() => new Set(linhasVisiveis.map((line) => line.personId)), [linhasVisiveis]);

  const atestadosVisiveis = useMemo(() => {
    return atestados.filter((item) => {
      if (!personIdsVisiveis.has(item.person_id_nexti)) return false;
      if (viewMode === "historico") return true;
      return matchesDateFilter(item, startDate, endDate, dateFilterMode);
    });
  }, [atestados, dateFilterMode, endDate, personIdsVisiveis, startDate, viewMode]);

  const monthlyTrend = useMemo(() => {
    return buildMonthlyPoints(
      atestadosVisiveis,
      viewMode === "controle" ? { start: startDate, end: endDate } : { lastMonths: 12 },
    );
  }, [atestadosVisiveis, endDate, startDate, viewMode]);

  const rankingEmpresas = useMemo(() => buildRanking(linhasVisiveis, (line) => line.empresa, 8), [linhasVisiveis]);
  const rankingUnidades = useMemo(() => buildRanking(linhasVisiveis, (line) => line.posto, 8), [linhasVisiveis]);
  const rankingColaboradores = useMemo(
    () =>
      linhasVisiveis.slice(0, 8).map((line) => ({
        label: line.colaborador,
        totalDias: line.totalDias,
        colaboradores: 1,
        afastados: line.afastamentoLancado ? 1 : 0,
      })),
    [linhasVisiveis],
  );

  const historicoSelecionado = useMemo(() => {
    if (!selected) return [];
    return sortAtestadosForDisplay(selected.atestados, dateFilterMode);
  }, [dateFilterMode, selected]);

  const operadorLancamentos = useMemo(() => {
    if (!operadorSelecionado) return [];

    return sortAtestadosForDisplay(
      atestados.filter(
        (item) =>
          item.lancado_por_id === operadorSelecionado.id &&
          matchesDateFilter(item, startDate, endDate, dateFilterMode),
      ),
      dateFilterMode,
    );
  }, [atestados, dateFilterMode, endDate, operadorSelecionado, startDate]);

  const pageDescription = useMemo(() => {
    const filterLabel = dateFilterMode === "data_lancamento"
      ? `lancados de ${periodLabel(startDate, endDate)}`
      : `do periodo ${periodLabel(startDate, endDate)}`;

    if (pageMode === "relatorios") {
      return viewMode === "controle"
        ? `Relatorios e graficos com base no controle atual ${filterLabel}`
        : "Relatorios e graficos com base nos colaboradores ativos que ja atingiram 16 dias ou mais em uma janela de 60 dias";
    }

    return viewMode === "controle"
      ? `Painel atual ${filterLabel}`
      : "Todos os colaboradores ativos que, em algum momento, ja atingiram 16 dias ou mais em uma janela de 60 dias";
  }, [dateFilterMode, endDate, pageMode, startDate, viewMode]);

  useEffect(() => {
    const wrap = tableWrapRef.current;
    const top = tableTopScrollRef.current;
    if (!wrap || !top) return;

    let syncingFromTop = false;
    let syncingFromWrap = false;

    const syncFromTop = () => {
      if (syncingFromWrap) return;
      syncingFromTop = true;
      wrap.scrollLeft = top.scrollLeft;
      syncingFromTop = false;
    };

    const syncFromWrap = () => {
      if (syncingFromTop) return;
      syncingFromWrap = true;
      top.scrollLeft = wrap.scrollLeft;
      syncingFromWrap = false;
    };

    top.addEventListener("scroll", syncFromTop);
    wrap.addEventListener("scroll", syncFromWrap);

    return () => {
      top.removeEventListener("scroll", syncFromTop);
      wrap.removeEventListener("scroll", syncFromWrap);
    };
  }, [linhasVisiveis.length, viewMode]);

  useEffect(() => {
    const wrap = tableWrapRef.current;
    const table = tableRef.current;
    if (!wrap || !table) return;

    const measure = () => {
      setTableClientWidth(wrap.clientWidth);
      setTableScrollWidth(table.scrollWidth);
      if (tableTopScrollRef.current) {
        tableTopScrollRef.current.scrollLeft = wrap.scrollLeft;
      }
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    observer.observe(table);
    window.addEventListener("resize", measure);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [linhasVisiveis.length, loading, viewMode]);

  const handleTopScrollPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = tableTopScrollRef.current;
    if (!element) return;
    topScrollDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: element.scrollLeft,
    };
    element.setPointerCapture(event.pointerId);
  };

  const handleTopScrollPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = tableTopScrollRef.current;
    const state = topScrollDragRef.current;
    if (!element || !state || state.pointerId !== event.pointerId) return;
    element.scrollLeft = state.startScrollLeft + (event.clientX - state.startX);
  };

  const handleTopScrollPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = tableTopScrollRef.current;
    const state = topScrollDragRef.current;
    if (!element || !state || state.pointerId !== event.pointerId) return;
    if (element.hasPointerCapture(event.pointerId)) {
      element.releasePointerCapture(event.pointerId);
    }
    topScrollDragRef.current = null;
  };

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
        <div className="topbar-copy">
          <p className="eyebrow">RH / DP</p>
          <h1>Controle de Atestados</h1>
          <p className="muted">{pageDescription}</p>
        </div>
        <div className="topbar-actions">
          <div className="view-switch view-switch-wide" aria-label="Navegacao principal">
            <button
              type="button"
              className={pageMode === "painel" && viewMode === "controle" ? "active" : ""}
              onClick={() => {
                setPageMode("painel");
                setViewMode("controle");
              }}
            >
              Controle atual
            </button>
            <button
              type="button"
              className={pageMode === "painel" && viewMode === "historico" ? "active" : ""}
              onClick={() => {
                setPageMode("painel");
                setViewMode("historico");
              }}
            >
              Quem ja atingiu 16+ em 60 dias
            </button>
            <button
              type="button"
              className={pageMode === "relatorios" ? "active" : ""}
              onClick={() => setPageMode("relatorios")}
            >
              RELATORIOS
            </button>
          </div>
        </div>
      </header>

      <section className="toolbar">
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
            <label className="field-inline">
              <CalendarDays size={16} />
              <select
                value={dateFilterMode}
                onChange={(event) => {
                  const mode = event.target.value as DateFilterMode;
                  setDateFilterMode(mode);
                  setSortOption(mode === "data_lancamento" ? "lancamento_desc" : "dias_desc");
                }}
              >
                <option value="periodo_atestado">Periodo do atestado</option>
                <option value="data_lancamento">Data de lancamento</option>
              </select>
            </label>
          </>
        ) : null}

        <label className="field-inline">
          <Filter size={16} />
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
            <option value="todos">Todos os status</option>
            <option value="alerta">So 16+</option>
            <option value="proximo">So 12 a 15</option>
            <option value="atencao">So 8 a 11</option>
            <option value="ok">So OK</option>
          </select>
        </label>

        <label className="field-inline">
          <ShieldAlert size={16} />
          <select
            value={afastamentoFilter}
            onChange={(event) => setAfastamentoFilter(event.target.value as AfastamentoFilter)}
          >
            <option value="todos">Todos os afastamentos</option>
            <option value="ocultar_lancados">Ocultar ja afastados</option>
            <option value="somente_lancados">So ja afastados</option>
            <option value="somente_pendentes">So 16+ sem afastamento</option>
          </select>
        </label>

        <label className="field-inline">
          <Building2 size={16} />
          <select value={empresaFilter} onChange={(event) => setEmpresaFilter(event.target.value)}>
            <option value="todas">Todas as empresas</option>
            {empresaOptions.map((empresa) => (
              <option key={empresa} value={empresa}>
                {empresa}
              </option>
            ))}
          </select>
        </label>

        <label className="field-inline">
          <BarChart3 size={16} />
          <select value={unidadeFilter} onChange={(event) => setUnidadeFilter(event.target.value)}>
            <option value="todas">Todas as unidades</option>
            {unidadeOptions.map((unidade) => (
              <option key={unidade} value={unidade}>
                {unidade}
              </option>
            ))}
          </select>
        </label>

        <label className="field-inline">
          <Users size={16} />
          <select value={sortOption} onChange={(event) => setSortOption(event.target.value as SortOption)}>
            {sortOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="search-field">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar matricula, nome, cargo, unidade ou empresa"
          />
        </label>
      </section>

      {error ? <div className="notice error">{error}</div> : null}

      {pageMode === "painel" ? (
        <>
          {viewMode === "controle" ? (
            <section className="summary-grid summary-grid-large">
              <article className="summary-card">
                <span>Total com atestado medico</span>
                <strong>{controleTotals.colaboradores}</strong>
                <small>{periodLabel(startDate, endDate)}</small>
              </article>
              {summaryConfig.slice(0, 3).map(({ key, label, icon: Icon }) => (
                <article className={`summary-card ${key}`} key={key}>
                  <span>{label}</span>
                  <strong>{controleTotals[key]}</strong>
                  <Icon size={20} />
                </article>
              ))}
              <article className="summary-card pending">
                <span>16+ sem afastamento</span>
                <strong>{controleTotals.pendentes}</strong>
                <small>Precisam de conferencia</small>
              </article>
              <article className="summary-card launched">
                <span>Ja afastados no Nexti</span>
                <strong>{controleTotals.lancados}</strong>
                <small>Com INSS / processo identificado</small>
              </article>
            </section>
          ) : (
            <section className="summary-grid summary-grid-large">
              <article className="summary-card alerta">
                <span>Quem ja atingiu 16+ em 60 dias</span>
                <strong>{historicoTotals.colaboradores}</strong>
                <small>Historico completo dos ativos</small>
              </article>
              <article className="summary-card launched">
                <span>Ja afastados no Nexti</span>
                <strong>{historicoTotals.lancados}</strong>
                <small>Com lancamento de afastamento identificado</small>
              </article>
              <article className="summary-card pending">
                <span>Sem afastamento identificado</span>
                <strong>{historicoTotals.pendentes}</strong>
                <small>Atingiram 16+ e seguem sem marca clara</small>
              </article>
              <article className="summary-card">
                <span>Maior pico em 60 dias</span>
                <strong>{historicoTotals.maiorPico}</strong>
                <small>Dias distintos dentro da janela critica</small>
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
                <h2>
                  {viewMode === "controle"
                    ? dateFilterMode === "data_lancamento"
                      ? "Controle por data de lancamento"
                      : "Controle do periodo"
                    : "Historico de quem ja atingiu 16 dias ou mais em qualquer janela de 60 dias"}
                </h2>
                <p>
                  {loading ? "Carregando dados..." : `${linhasVisiveis.length} colaboradores encontrados`}
                  {syncLog ? ` | Base atualizada em ${formatDateTimeBR(syncLog.finalizado_em ?? syncLog.iniciado_em)}` : ""}
                </p>
              </div>
              <div className="section-actions">
                <button
                  className="icon-button secondary"
                  type="button"
                  onClick={() => void loadData()}
                  disabled={loading || syncing}
                >
                  <RefreshCw size={16} />
                  {loading ? "Atualizando..." : "Atualizar"}
                </button>
                <button
                  className="icon-button secondary"
                  type="button"
                  onClick={() => void syncNexti()}
                  disabled={loading || syncing}
                >
                  <RefreshCw size={16} />
                  {syncing ? "Sincronizando..." : "Sincronizar Nexti"}
                </button>
                <button
                  className="icon-button secondary"
                  type="button"
                  onClick={() => exportLinhasCsv(linhasVisiveis, viewMode)}
                >
                  <Download size={16} />
                  Exportar CSV
                </button>
              </div>
            </div>

            {tableScrollWidth > tableClientWidth ? (
              <div
                className="table-scroll-top"
                ref={tableTopScrollRef}
                onPointerDown={handleTopScrollPointerDown}
                onPointerMove={handleTopScrollPointerMove}
                onPointerUp={handleTopScrollPointerEnd}
                onPointerCancel={handleTopScrollPointerEnd}
              >
                <div style={{ width: tableScrollWidth, height: 1 }} />
              </div>
            ) : null}

            <div className="table-wrap" ref={tableWrapRef}>
              <table ref={tableRef}>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Dias</th>
                    <th>Matricula</th>
                    <th>Colaborador</th>
                    <th>Empresa</th>
                    <th>Cargo</th>
                    <th>Unidade / posto</th>
                    <th>Primeiro</th>
                    <th>Ultimo</th>
                    <th>Ultimo lancamento</th>
                    <th>Periodo</th>
                  </tr>
                </thead>
                <tbody>
                  {linhasVisiveis.map((line) => (
                    <tr key={line.personId} className={`line-${line.afastamentoStatus}`}>
                      <td>
                        <span className={`status-pill ${line.status}`}>{statusLabels[line.status]}</span>
                      </td>
                      <td className="days">{line.totalDias}</td>
                      <td>{line.matricula}</td>
                      <td className="cell-wrap cell-colaborador">
                        <button className="colaborador-link" type="button" onClick={() => setSelected(line)}>
                          <span className="colaborador-copy">
                            <span>{line.colaborador}</span>
                            {line.afastamentoLancado ? <span className="colaborador-badge">Afastado</span> : null}
                          </span>
                          <Eye size={14} />
                        </button>
                      </td>
                      <td className="cell-wrap">{line.empresa}</td>
                      <td className="cell-wrap">{line.cargo}</td>
                      <td className="cell-wrap cell-posto">{line.posto}</td>
                      <td>{formatDateBR(line.primeiroAtestado)}</td>
                      <td>{formatDateBR(line.ultimoAtestado)}</td>
                      <td>{formatDateBR(line.ultimoLancamento)}</td>
                      <td>{line.periodo}</td>
                    </tr>
                  ))}
                  {!loading && linhasVisiveis.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="empty-state">
                        {viewMode === "controle"
                          ? "Nenhum atestado medico encontrado com os filtros atuais."
                          : "Nenhum colaborador ativo atingiu 16 dias em uma janela de 60 dias com os filtros atuais."}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : (
        <>
          <section className="summary-grid summary-grid-large">
            <article className="summary-card">
              <span>Colaboradores no recorte</span>
              <strong>{reportTotals.colaboradores}</strong>
              <small>{viewMode === "controle" ? periodLabel(startDate, endDate) : "Base historica 16+ em 60 dias"}</small>
            </article>
            <article className="summary-card alerta">
              <span>Total de dias analisados</span>
              <strong>{reportTotals.totalDias}</strong>
              <small>Dias somados no conjunto filtrado</small>
            </article>
            <article className="summary-card launched">
              <span>Ja afastados no Nexti</span>
              <strong>{reportTotals.lancados}</strong>
              <small>Com badge de afastamento no painel</small>
            </article>
            <article className="summary-card pending">
              <span>16+ sem afastamento</span>
              <strong>{reportTotals.pendentes}</strong>
              <small>Necessitam conferencia operacional</small>
            </article>
            <article className="summary-card">
              <span>Empresas no recorte</span>
              <strong>{reportTotals.empresas}</strong>
              <small>Organizacoes com ocorrencias filtradas</small>
            </article>
            <article className="summary-card">
              <span>Unidades / postos</span>
              <strong>{reportTotals.unidades}</strong>
              <small>Locais com atestados no conjunto atual</small>
            </article>
          </section>

          <section className="table-section report-section">
            <div className="section-heading">
              <div>
                <h2>Relatorios e graficos</h2>
                <p>
                  {viewMode === "controle"
                    ? `Base: controle atual de ${periodLabel(startDate, endDate)}`
                    : "Base: colaboradores ativos que ja atingiram 16 dias ou mais em uma janela de 60 dias"}
                </p>
              </div>
              <div className="section-actions">
                <button
                  className="icon-button secondary"
                  type="button"
                  onClick={() => exportLinhasCsv(linhasVisiveis, viewMode)}
                >
                  <Download size={16} />
                  Exportar base filtrada
                </button>
              </div>
            </div>
          </section>

          <section className="reports-grid">
            <article className="report-card report-card-wide">
              <div className="report-card-header">
                <div>
                  <p className="eyebrow">Relatorio por periodo</p>
                  <h3>Evolucao mensal</h3>
                </div>
                <p className="muted">
                  {viewMode === "controle" ? periodLabel(startDate, endDate) : "Ultimos 12 meses dos colaboradores filtrados"}
                </p>
              </div>
              <MonthlyBarsChart data={monthlyTrend} />
            </article>

            <article className="report-card">
              <div className="report-card-header">
                <div>
                  <p className="eyebrow">Controle de afastamento</p>
                  <h3>Situacao do grupo filtrado</h3>
                </div>
              </div>
              <BreakdownList
                items={[
                  {
                    label: "Ja afastados no Nexti",
                    value: linhasContexto.filter((line) => line.afastamentoStatus === "lancado").length,
                    tone: "lancado",
                  },
                  {
                    label: "16+ sem afastamento",
                    value: linhasContexto.filter((line) => line.afastamentoStatus === "pendente").length,
                    tone: "pendente",
                  },
                  {
                    label: "Monitorando",
                    value: linhasContexto.filter((line) => line.afastamentoStatus === "monitorando").length,
                    tone: "monitorando",
                  },
                ]}
              />
            </article>

            <article className="report-card">
              <div className="report-card-header">
                <div>
                  <p className="eyebrow">Empresas</p>
                  <h3>Maior concentracao de dias</h3>
                </div>
              </div>
              <RankingBars items={rankingEmpresas} />
            </article>

            <article className="report-card">
              <div className="report-card-header">
                <div>
                  <p className="eyebrow">Unidades / postos</p>
                  <h3>Top unidades no recorte</h3>
                </div>
              </div>
              <RankingBars items={rankingUnidades} />
            </article>

            <article className="report-card">
              <div className="report-card-header">
                <div>
                  <p className="eyebrow">Colaboradores</p>
                  <h3>Maiores acumulados</h3>
                </div>
              </div>
              <RankingBars items={rankingColaboradores} />
            </article>
          </section>
        </>
      )}

      {selected ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setSelected(null)}>
          <section className="modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <p className="eyebrow">{selected.matricula}</p>
                <h2>{selected.colaborador}</h2>
                <p className="muted">
                  {selected.empresa} | {selected.cargo} | {selected.posto}
                </p>
                <p className="muted">
                  {selected.afastamentoLabel}
                  {isHistoricoLinha(selected) ? ` | Janela critica: ${selected.periodo}` : ""}
                </p>
              </div>
              <div className="modal-actions">
                <button
                  className="icon-button secondary"
                  type="button"
                  onClick={() => exportHistoricoCsv(selected, historicoSelecionado)}
                >
                  <Download size={16} />
                  Exportar historico
                </button>
                <button
                  className="icon-only"
                  type="button"
                  onClick={() => {
                    setSelected(null);
                    setOperadorSelecionado(null);
                  }}
                  aria-label="Fechar"
                >
                  x
                </button>
              </div>
            </div>

            <div className="modal-summary-grid">
              <article className="report-stat">
                <span>Total de dias</span>
                <strong>{selected.totalDias}</strong>
              </article>
              <article className="report-stat">
                <span>Lancamentos detalhados</span>
                <strong>{historicoSelecionado.length}</strong>
              </article>
              <article className="report-stat">
                <span>Primeiro do recorte</span>
                <strong>{formatDateBR(selected.primeiroAtestado)}</strong>
              </article>
              <article className="report-stat">
                <span>Ultimo do recorte</span>
                <strong>{formatDateBR(selected.ultimoAtestado)}</strong>
              </article>
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
                  {historicoSelecionado.map((item) => {
                    const operador = getOperadorInfo(item);

                    return (
                      <tr key={item.id}>
                        <td>{formatDateBR(item.data_inicio)}</td>
                        <td>{formatDateBR(item.data_fim)}</td>
                        <td className="days">{item.dias}</td>
                        <td>{formatDateTimeBR(item.data_lancamento)}</td>
                        <td>
                          {operador ? (
                            <button
                              className="inline-link"
                              type="button"
                              onClick={() => setOperadorSelecionado(operador)}
                            >
                              {operador.nome}
                            </button>
                          ) : (
                            formatLancadoPor(item)
                          )}
                        </td>
                        <td>{item.cid ?? "-"}</td>
                        <td>{item.medico ?? "-"}</td>
                        <td>{item.tipo_ausencia_nome ?? item.tipo_ausencia_id ?? item.tipo_ausencia_external_id ?? "-"}</td>
                        <td>{item.id_nexti}</td>
                        <td className="cell-wrap cell-observacao">{item.observacao ?? "-"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : null}

      {operadorSelecionado ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setOperadorSelecionado(null)}>
          <section className="modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <p className="eyebrow">Operador Nexti {operadorSelecionado.id}</p>
                <h2>{operadorSelecionado.nome}</h2>
                <p className="muted">
                  Lancamentos no filtro atual: {dateFilterMode === "data_lancamento" ? "data de lancamento" : "periodo do atestado"} |{" "}
                  {periodLabel(startDate, endDate)}
                </p>
              </div>
              <button className="icon-only" type="button" onClick={() => setOperadorSelecionado(null)} aria-label="Fechar">
                x
              </button>
            </div>

            <div className="modal-summary-grid">
              <article className="report-stat">
                <span>Lancamentos</span>
                <strong>{operadorLancamentos.length}</strong>
              </article>
              <article className="report-stat">
                <span>Total de dias</span>
                <strong>{operadorLancamentos.reduce((sum, item) => sum + item.dias, 0)}</strong>
              </article>
              <article className="report-stat">
                <span>Colaboradores</span>
                <strong>{new Set(operadorLancamentos.map((item) => item.person_id_nexti)).size}</strong>
              </article>
              <article className="report-stat">
                <span>Periodo</span>
                <strong>{periodLabel(startDate, endDate)}</strong>
              </article>
            </div>

            <div className="table-wrap compact">
              <table>
                <thead>
                  <tr>
                    <th>Colaborador</th>
                    <th>Matricula</th>
                    <th>Inicio</th>
                    <th>Fim</th>
                    <th>Dias</th>
                    <th>Lancamento</th>
                    <th>CID</th>
                    <th>Medico</th>
                    <th>Tipo</th>
                    <th>ID Nexti</th>
                  </tr>
                </thead>
                <tbody>
                  {operadorLancamentos.map((item) => (
                    <tr key={item.id}>
                      <td className="cell-wrap cell-colaborador">{item.colaboradores?.nome ?? `Colaborador ${item.person_id_nexti}`}</td>
                      <td>{item.colaboradores?.matricula ?? item.matricula ?? "-"}</td>
                      <td>{formatDateBR(item.data_inicio)}</td>
                      <td>{formatDateBR(item.data_fim)}</td>
                      <td className="days">{item.dias}</td>
                      <td>{formatDateTimeBR(item.data_lancamento)}</td>
                      <td>{item.cid ?? "-"}</td>
                      <td>{item.medico ?? "-"}</td>
                      <td>{item.tipo_ausencia_nome ?? item.tipo_ausencia_id ?? item.tipo_ausencia_external_id ?? "-"}</td>
                      <td>{item.id_nexti}</td>
                    </tr>
                  ))}
                  {operadorLancamentos.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="empty-state">
                        Nenhum lancamento encontrado para este operador no filtro atual.
                      </td>
                    </tr>
                  ) : null}
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

function getOperadorInfo(item: Atestado): OperadorSelecionado | null {
  if (typeof item.lancado_por_id !== "number") return null;
  return {
    id: item.lancado_por_id,
    nome: formatLancadoPor(item),
  };
}

function uniqueOptions(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value && value !== "-")))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function sortLinhas<T extends LinhaSelecionavel>(lines: T[], sortOption: SortOption): T[] {
  const sorted = [...lines];

  sorted.sort((a, b) => {
    switch (sortOption) {
      case "dias_asc":
        return a.totalDias - b.totalDias || a.colaborador.localeCompare(b.colaborador);
      case "nome_asc":
        return a.colaborador.localeCompare(b.colaborador);
      case "empresa_asc":
        return a.empresa.localeCompare(b.empresa) || a.colaborador.localeCompare(b.colaborador);
      case "posto_asc":
        return a.posto.localeCompare(b.posto) || a.colaborador.localeCompare(b.colaborador);
      case "primeiro_desc":
        return b.primeiroAtestado.localeCompare(a.primeiroAtestado) || b.totalDias - a.totalDias;
      case "ultimo_desc":
        return b.ultimoAtestado.localeCompare(a.ultimoAtestado) || b.totalDias - a.totalDias;
      case "lancamento_desc":
        return compareNullableDatesDesc(a.ultimoLancamento, b.ultimoLancamento) || b.totalDias - a.totalDias;
      case "dias_desc":
      default:
        return b.totalDias - a.totalDias || a.colaborador.localeCompare(b.colaborador);
    }
  });

  return sorted;
}

function sortAtestadosForDisplay(items: Atestado[], dateFilterMode: DateFilterMode): Atestado[] {
  return [...items].sort((a, b) => {
    if (dateFilterMode === "data_lancamento") {
      return compareNullableDatesDesc(a.data_lancamento, b.data_lancamento) || b.id_nexti - a.id_nexti;
    }

    return b.data_inicio.localeCompare(a.data_inicio) || b.id_nexti - a.id_nexti;
  });
}

function compareNullableDatesDesc(left: string | null | undefined, right: string | null | undefined): number {
  const leftValue = left ?? "";
  const rightValue = right ?? "";
  return rightValue.localeCompare(leftValue);
}

function buildRanking(lines: LinhaSelecionavel[], pickLabel: (line: LinhaSelecionavel) => string, limit: number): RankingItem[] {
  const grouped = new Map<string, RankingItem>();

  for (const line of lines) {
    const label = pickLabel(line) || "-";
    const current = grouped.get(label) ?? { label, totalDias: 0, colaboradores: 0, afastados: 0 };
    current.totalDias += line.totalDias;
    current.colaboradores += 1;
    current.afastados += line.afastamentoLancado ? 1 : 0;
    grouped.set(label, current);
  }

  return Array.from(grouped.values())
    .sort((a, b) => b.totalDias - a.totalDias || a.label.localeCompare(b.label))
    .slice(0, limit);
}

function buildMonthlyPoints(
  atestados: Atestado[],
  options: { start?: string; end?: string; lastMonths?: number },
): MonthlyPoint[] {
  if (atestados.length === 0) return [];

  const clampedDays = new Map<string, { totalDias: number; colaboradores: Set<number> }>();
  let minMonthKey = "";
  let maxMonthKey = "";

  for (const atestado of atestados) {
    const range = clampRangeByOptions(atestado.data_inicio, atestado.data_fim, options);
    if (!range) continue;

    let current = range.start;
    while (current <= range.end) {
      const key = current.slice(0, 7);
      const currentMonth = clampedDays.get(key) ?? { totalDias: 0, colaboradores: new Set<number>() };
      currentMonth.totalDias += 1;
      currentMonth.colaboradores.add(atestado.person_id_nexti);
      clampedDays.set(key, currentMonth);

      if (!minMonthKey || key < minMonthKey) minMonthKey = key;
      if (!maxMonthKey || key > maxMonthKey) maxMonthKey = key;
      current = addOneDay(current);
    }
  }

  if (!minMonthKey || !maxMonthKey) return [];

  const allKeys = enumerateMonthKeys(minMonthKey, maxMonthKey);
  const limitedKeys = options.lastMonths ? allKeys.slice(-options.lastMonths) : allKeys;

  return limitedKeys.map((key) => {
    const item = clampedDays.get(key);
    return {
      key,
      label: formatMonthLabel(key),
      totalDias: item?.totalDias ?? 0,
      colaboradores: item?.colaboradores.size ?? 0,
    };
  });
}

function clampRangeByOptions(
  start: string,
  end: string,
  options: { start?: string; end?: string },
): { start: string; end: string } | null {
  const rangeStart = options.start && start < options.start ? options.start : start;
  const rangeEnd = options.end && end > options.end ? options.end : end;
  return rangeStart <= rangeEnd ? { start: rangeStart, end: rangeEnd } : null;
}

function addOneDay(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() + 1);
  return toDateOnly(date);
}

function toDateOnly(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function enumerateMonthKeys(startKey: string, endKey: string): string[] {
  const keys: string[] = [];
  let cursor = new Date(`${startKey}-01T00:00:00`);
  const finish = new Date(`${endKey}-01T00:00:00`);

  while (cursor <= finish) {
    keys.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`);
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }

  return keys;
}

function formatMonthLabel(key: string): string {
  const [year, month] = key.split("-");
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString("pt-BR", { month: "short", year: "2-digit" });
}

function exportLinhasCsv(lines: LinhaSelecionavel[], viewMode: ViewMode) {
  const headers = [
    "Status",
    "Afastamento",
    "Dias",
    "Matricula",
    "Colaborador",
    "Empresa",
    "Cargo",
    "Unidade/Posto",
    "Primeiro",
    "Ultimo",
    "Ultimo lancamento",
    "Periodo",
  ];

  const rows = lines.map((line) => [
    statusLabels[line.status],
    line.afastamentoLabel,
    String(line.totalDias),
    line.matricula,
    line.colaborador,
    line.empresa,
    line.cargo,
    line.posto,
    formatDateBR(line.primeiroAtestado),
    formatDateBR(line.ultimoAtestado),
    formatDateBR(line.ultimoLancamento),
    line.periodo,
  ]);

  downloadCsv(
    `${viewMode === "controle" ? "controle" : "historico-16-em-60"}-${new Date().toISOString().slice(0, 10)}.csv`,
    headers,
    rows,
  );
}

function exportHistoricoCsv(selected: LinhaSelecionavel, items: Atestado[]) {
  const headers = [
    "Colaborador",
    "Matricula",
    "Afastamento",
    "Data inicio",
    "Data fim",
    "Dias",
    "Data lancamento",
    "Lancado por",
    "CID",
    "Medico",
    "Tipo",
    "ID Nexti",
    "Observacao",
  ];

  const rows = items.map((item) => [
    selected.colaborador,
    selected.matricula,
    selected.afastamentoLabel,
    formatDateBR(item.data_inicio),
    formatDateBR(item.data_fim),
    String(item.dias),
    formatDateTimeBR(item.data_lancamento),
    formatLancadoPor(item),
    item.cid ?? "-",
    item.medico ?? "-",
    item.tipo_ausencia_nome ?? String(item.tipo_ausencia_id ?? item.tipo_ausencia_external_id ?? "-"),
    String(item.id_nexti),
    item.observacao ?? "-",
  ]);

  downloadCsv(`${slugify(selected.colaborador)}-historico.csv`, headers, rows);
}

function downloadCsv(filename: string, headers: string[], rows: string[][]) {
  const csv = [headers, ...rows]
    .map((row) => row.map((value) => `"${String(value ?? "").replace(/"/g, "\"\"")}"`).join(";"))
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function slugify(value: string): string {
  return normalizeComparable(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "relatorio";
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
      .select(`
        id,
        id_nexti,
        person_id_nexti,
        matricula,
        data_inicio,
        data_fim,
        dias,
        data_lancamento,
        lancado_por,
        cid,
        observacao,
        tipo_ausencia_id,
        tipo_ausencia_external_id,
        tipo_ausencia_nome,
        eh_atestado_medico,
        removido,
        lancado_por_id,
        lancado_por_nome,
        medico,
        colaboradores!inner (
          id,
          person_id_nexti,
          matricula,
          nome,
          cargo,
          posto,
          empresa,
          situacao,
          ultima_atualizacao,
          ativo,
          data_desligamento,
          user_account_id_nexti
        )
      `)
      .eq("removido", false)
      .eq("eh_atestado_medico", true)
      .eq("colaboradores.ativo", true)
      .is("colaboradores.data_desligamento", null)
      .order("data_inicio", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      return { data: null, error: new Error(error.message) };
    }

    const chunk = (data ?? []) as unknown as Atestado[];
    rows.push(...chunk);

    if (chunk.length < PAGE_SIZE) {
      break;
    }

    from += PAGE_SIZE;
  }

  return { data: rows, error: null };
}

function MonthlyBarsChart({ data, compact = false }: { data: MonthlyPoint[]; compact?: boolean }) {
  const maxValue = Math.max(...data.map((item) => item.totalDias), 1);

  if (data.length === 0) {
    return <p className="muted">Sem dados suficientes para montar o grafico neste recorte.</p>;
  }

  return (
    <div className={`monthly-chart ${compact ? "compact" : ""}`}>
      {data.map((item) => (
        <div className="monthly-bar" key={item.key}>
          <span className="monthly-value">{item.totalDias}</span>
          <div className="monthly-track">
            <div className="monthly-fill" style={{ height: `${Math.max(8, (item.totalDias / maxValue) * 100)}%` }} />
          </div>
          <strong>{item.label}</strong>
          <small>{item.colaboradores} colab.</small>
        </div>
      ))}
    </div>
  );
}

function RankingBars({ items }: { items: RankingItem[] }) {
  const maxValue = Math.max(...items.map((item) => item.totalDias), 1);

  if (items.length === 0) {
    return <p className="muted">Nenhum dado disponivel com os filtros atuais.</p>;
  }

  return (
    <div className="ranking-list">
      {items.map((item) => (
        <div className="ranking-row" key={item.label}>
          <div className="ranking-copy">
            <strong>{item.label}</strong>
            <small>
              {item.colaboradores} colab. {item.afastados > 0 ? `| ${item.afastados} ja afastados` : ""}
            </small>
          </div>
          <div className="ranking-bar-area">
            <div className="ranking-bar-track">
              <div className="ranking-bar-fill" style={{ width: `${(item.totalDias / maxValue) * 100}%` }} />
            </div>
            <span>{item.totalDias} dias</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function BreakdownList({
  items,
}: {
  items: Array<{ label: string; value: number; tone: AfastamentoState | "alerta" | "neutro" }>;
}) {
  const total = items.reduce((sum, item) => sum + item.value, 0) || 1;

  return (
    <div className="breakdown-list">
      {items.map((item) => (
        <div className="breakdown-row" key={item.label}>
          <div>
            <strong>{item.label}</strong>
            <small>{item.value} colaboradores</small>
          </div>
          <div className="breakdown-meter">
            <div className="breakdown-track">
              <div
                className={`breakdown-fill ${item.tone}`}
                style={{ width: `${Math.max(8, (item.value / total) * 100)}%` }}
              />
            </div>
            <span>{Math.round((item.value / total) * 100)}%</span>
          </div>
        </div>
      ))}
    </div>
  );
}
