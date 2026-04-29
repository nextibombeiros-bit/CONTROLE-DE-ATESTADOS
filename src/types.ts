export type StatusKey = "alerta" | "proximo" | "atencao" | "ok";

export type Colaborador = {
  id: string;
  person_id_nexti: number;
  matricula: string | null;
  nome: string;
  cargo: string | null;
  posto: string | null;
  empresa: string | null;
  situacao: string | null;
  ultima_atualizacao: string | null;
  ativo: boolean;
  data_desligamento: string | null;
  user_account_id_nexti: number | null;
};

export type Atestado = {
  id: string;
  id_nexti: number;
  person_id_nexti: number;
  matricula: string | null;
  data_inicio: string;
  data_fim: string;
  dias: number;
  data_lancamento: string | null;
  lancado_por: string | null;
  cid: string | null;
  observacao: string | null;
  tipo_ausencia_id: number | null;
  tipo_ausencia_external_id: string | null;
  tipo_ausencia_nome: string | null;
  eh_atestado_medico: boolean;
  removido: boolean;
  lancado_por_id: number | null;
  lancado_por_nome: string | null;
  medico: string | null;
  colaboradores?: Colaborador | null;
};

export type ControleLinha = {
  personId: number;
  status: StatusKey;
  totalDias: number;
  matricula: string;
  colaborador: string;
  cargo: string;
  posto: string;
  primeiroAtestado: string;
  ultimoAtestado: string;
  periodo: string;
  atestados: Atestado[];
};

export type Sincronizacao = {
  id: string;
  iniciado_em: string;
  finalizado_em: string | null;
  status: "em_execucao" | "sucesso" | "erro";
  periodo_inicio: string | null;
  periodo_fim: string | null;
  quantidade_importada: number;
  quantidade_atualizada: number;
  erro: string | null;
  detalhes?: {
    automatic?: boolean;
    [key: string]: unknown;
  } | null;
};
