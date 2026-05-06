import { buildControle } from "@/lib/controle.ts";
import type { Atestado, Colaborador, DateFilterMode } from "@/types.ts";

const marlene: Colaborador = {
  id: "colaborador-marlene",
  person_id_nexti: 5646693,
  matricula: "7395",
  nome: "MARLENE TEIXEIRA FONSECA",
  cargo: "CONTROLADOR DE ACESSO",
  posto: "POSTO TESTE",
  empresa: "Acaz",
  situacao: "TRABALHANDO",
  ultima_atualizacao: null,
  ativo: true,
  data_desligamento: null,
  user_account_id_nexti: null,
};

function makeAtestado(partial: Partial<Atestado> & Pick<Atestado, "id_nexti" | "data_inicio" | "data_fim" | "dias" | "data_lancamento">): Atestado {
  const { id_nexti, data_inicio, data_fim, dias, data_lancamento, ...rest } = partial;

  return {
    id: `atestado-${id_nexti}`,
    id_nexti,
    person_id_nexti: 5646693,
    matricula: "7395",
    data_inicio,
    data_fim,
    dias,
    data_lancamento,
    lancado_por: "OPERADOR TESTE",
    cid: null,
    observacao: null,
    tipo_ausencia_id: null,
    tipo_ausencia_external_id: null,
    tipo_ausencia_nome: "ATESTADO",
    eh_atestado_medico: true,
    removido: false,
    lancado_por_id: 1,
    lancado_por_nome: "OPERADOR TESTE",
    medico: null,
    colaboradores: marlene,
    ...rest,
  };
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}. Esperado: ${expected}. Recebido: ${actual}`);
  }
}

function totalForMarlene(mode: DateFilterMode, start: string, end: string): number {
  const linhas = buildControle(
    [
      makeAtestado({
        id_nexti: 91064142,
        data_inicio: "2026-05-04",
        data_fim: "2026-05-10",
        dias: 7,
        data_lancamento: "2026-05-05T14:07:46+00:00",
      }),
      makeAtestado({
        id_nexti: 90180505,
        data_inicio: "2026-04-19",
        data_fim: "2026-04-21",
        dias: 3,
        data_lancamento: "2026-04-21T00:34:06+00:00",
      }),
      makeAtestado({
        id_nexti: 89459599,
        data_inicio: "2026-04-09",
        data_fim: "2026-04-11",
        dias: 3,
        data_lancamento: "2026-04-10T02:18:37+00:00",
      }),
    ],
    start,
    end,
    mode,
  );

  return linhas.find((line) => line.matricula === "7395")?.totalDias ?? 0;
}

assertEqual(
  totalForMarlene("periodo_atestado", "2026-03-07", "2026-05-05"),
  13,
  "O painel deve somar os dias Nexti dos lancamentos visiveis, sem recortar o atestado futuro",
);

assertEqual(
  totalForMarlene("data_lancamento", "2026-04-01", "2026-05-05"),
  13,
  "O filtro por data de lancamento deve somar os lancamentos feitos dentro do periodo",
);

assertEqual(
  totalForMarlene("data_lancamento", "2026-05-01", "2026-05-05"),
  7,
  "O filtro por data de lancamento deve excluir lancamentos fora do periodo",
);
