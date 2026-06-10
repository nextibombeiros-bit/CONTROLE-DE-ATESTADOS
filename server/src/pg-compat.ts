import pg from "pg";

const { Pool, types } = pg;

types.setTypeParser(20, (value) => Number(value));

type QueryResult<T> = {
  data: T | null;
  error: Error | null;
};

type Filter = {
  column: string;
  operator: "=" | ">=" | "in" | "is" | "is_not";
  value: unknown;
};

type Sort = {
  column: string;
  ascending: boolean;
};

type Operation = "select" | "insert" | "update" | "upsert";

const allowedTables = new Set(["atestados", "colaboradores", "sincronizacoes"]);

export class PgCompatClient {
  constructor(private readonly pool: pg.Pool) {}

  static fromConnectionString(connectionString: string) {
    return new PgCompatClient(new Pool({ connectionString }));
  }

  from(table: string) {
    if (!allowedTables.has(table)) {
      throw new Error(`Tabela nao permitida: ${table}`);
    }

    return new PgQueryBuilder(this.pool, table);
  }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values: unknown[] = []) {
    const result = await this.pool.query<T>(text, values);
    if (Array.isArray(result)) {
      return normalizeRows(result.flatMap((item) => item.rows ?? []));
    }

    return normalizeRows(result.rows ?? []);
  }

  async close() {
    await this.pool.end();
  }
}

export type CompatDbClient = PgCompatClient;

class PgQueryBuilder implements PromiseLike<QueryResult<any>> {
  private operation: Operation = "select";
  private selectedColumns = "*";
  private returningColumns: string | null = null;
  private payload: Record<string, unknown> | Array<Record<string, unknown>> | null = null;
  private filters: Filter[] = [];
  private sorts: Sort[] = [];
  private limitValue: number | null = null;
  private offsetValue = 0;
  private singleMode: "single" | "maybeSingle" | null = null;
  private conflictColumn: string | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly table: string,
  ) {}

  select(columns = "*") {
    if (this.operation === "insert" || this.operation === "update" || this.operation === "upsert") {
      this.returningColumns = columns;
    } else {
      this.operation = "select";
      this.selectedColumns = columns;
    }

    return this;
  }

  insert(payload: Record<string, unknown> | Array<Record<string, unknown>>) {
    this.operation = "insert";
    this.payload = payload;
    return this;
  }

  update(payload: Record<string, unknown>) {
    this.operation = "update";
    this.payload = payload;
    return this;
  }

  upsert(payload: Record<string, unknown> | Array<Record<string, unknown>>, options: { onConflict: string }) {
    this.operation = "upsert";
    this.payload = payload;
    this.conflictColumn = options.onConflict;
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ column, operator: "=", value });
    return this;
  }

  gte(column: string, value: unknown) {
    this.filters.push({ column, operator: ">=", value });
    return this;
  }

  in(column: string, value: unknown[]) {
    this.filters.push({ column, operator: "in", value });
    return this;
  }

  is(column: string, value: null) {
    if (value !== null) throw new Error("Somente filtros IS NULL sao suportados");
    this.filters.push({ column, operator: "is", value });
    return this;
  }

  not(column: string, operator: string, value: null) {
    if (operator !== "is" || value !== null) {
      throw new Error("Somente filtros IS NOT NULL sao suportados");
    }

    this.filters.push({ column, operator: "is_not", value });
    return this;
  }

  order(column: string, options: { ascending?: boolean } = {}) {
    this.sorts.push({ column, ascending: options.ascending ?? true });
    return this;
  }

  limit(value: number) {
    this.limitValue = value;
    return this;
  }

  range(from: number, to: number) {
    this.offsetValue = from;
    this.limitValue = Math.max(0, to - from + 1);
    return this;
  }

  async single(): Promise<QueryResult<any>> {
    this.singleMode = "single";
    return this.execute();
  }

  async maybeSingle(): Promise<QueryResult<any>> {
    this.singleMode = "maybeSingle";
    return this.execute();
  }

  then<TResult1 = QueryResult<any>, TResult2 = never>(
    onfulfilled?: ((value: QueryResult<any>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<QueryResult<any>> {
    try {
      const { sql, values } = this.toSql();
      const result = await this.pool.query(sql, values);
      const rows = normalizeRows(result.rows);

      if (this.singleMode === "single") {
        if (rows.length !== 1) {
          return { data: null, error: new Error(`Esperava 1 registro em ${this.table}, recebeu ${rows.length}`) };
        }

        return { data: rows[0], error: null };
      }

      if (this.singleMode === "maybeSingle") {
        return { data: rows[0] ?? null, error: null };
      }

      return { data: rows, error: null };
    } catch (error) {
      return { data: null, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  private toSql() {
    if (this.operation === "select") return this.selectSql();
    if (this.operation === "update") return this.updateSql();
    if (this.operation === "insert") return this.insertSql(false);
    return this.insertSql(true);
  }

  private selectSql() {
    const values: unknown[] = [];
    const where = this.whereSql(values);
    const order = this.orderSql();
    const limit = this.limitSql(values);
    return {
      sql: `select ${selectList(this.selectedColumns)} from ${quoteIdent(this.table)}${where}${order}${limit}`,
      values,
    };
  }

  private updateSql() {
    const payload = ensureSinglePayload(this.payload);
    const values: unknown[] = [];
    const assignments = Object.keys(payload).map((column) => `${quoteIdent(column)} = $${push(values, payload[column])}`);
    const where = this.whereSql(values);
    const returning = this.returningColumns ? ` returning ${selectList(this.returningColumns)}` : "";

    return {
      sql: `update ${quoteIdent(this.table)} set ${assignments.join(", ")}${where}${returning}`,
      values,
    };
  }

  private insertSql(upsert: boolean) {
    const rows = ensureArrayPayload(this.payload);
    if (rows.length === 0) {
      return { sql: `select * from ${quoteIdent(this.table)} where false`, values: [] };
    }

    const columns = uniqueColumns(rows);
    const values: unknown[] = [];
    const tuples = rows.map((row) => {
      const params = columns.map((column) => `$${push(values, row[column] ?? null)}`);
      return `(${params.join(", ")})`;
    });

    const conflict = upsert ? this.conflictSql(columns) : "";
    const returning = this.returningColumns ? ` returning ${selectList(this.returningColumns)}` : "";

    return {
      sql: `insert into ${quoteIdent(this.table)} (${columns.map(quoteIdent).join(", ")}) values ${tuples.join(", ")}${conflict}${returning}`,
      values,
    };
  }

  private conflictSql(columns: string[]) {
    if (!this.conflictColumn) throw new Error("onConflict obrigatorio para upsert");
    const conflict = quoteIdent(this.conflictColumn);
    const updates = columns
      .filter((column) => column !== this.conflictColumn)
      .map((column) => `${quoteIdent(column)} = excluded.${quoteIdent(column)}`);

    return ` on conflict (${conflict}) do update set ${updates.join(", ")}`;
  }

  private whereSql(values: unknown[]) {
    if (this.filters.length === 0) return "";

    const clauses = this.filters.map((filter) => {
      const column = quoteIdent(filter.column);
      if (filter.operator === "is") return `${column} is null`;
      if (filter.operator === "is_not") return `${column} is not null`;
      if (filter.operator === "in") {
        const list = filter.value as unknown[];
        if (list.length === 0) return "false";
        const params = list.map((value) => `$${push(values, value)}`);
        return `${column} in (${params.join(", ")})`;
      }

      return `${column} ${filter.operator} $${push(values, filter.value)}`;
    });

    return ` where ${clauses.join(" and ")}`;
  }

  private orderSql() {
    if (this.sorts.length === 0) return "";
    return ` order by ${this.sorts.map((sort) => `${quoteIdent(sort.column)} ${sort.ascending ? "asc" : "desc"}`).join(", ")}`;
  }

  private limitSql(values: unknown[]) {
    const fragments: string[] = [];
    if (this.limitValue !== null) fragments.push(`limit $${push(values, this.limitValue)}`);
    if (this.offsetValue > 0) fragments.push(`offset $${push(values, this.offsetValue)}`);
    return fragments.length > 0 ? ` ${fragments.join(" ")}` : "";
  }
}

function ensureSinglePayload(payload: PgQueryBuilder["payload"]) {
  if (!payload || Array.isArray(payload)) throw new Error("Payload unico obrigatorio");
  return payload;
}

function ensureArrayPayload(payload: PgQueryBuilder["payload"]) {
  if (!payload) throw new Error("Payload obrigatorio");
  return Array.isArray(payload) ? payload : [payload];
}

function uniqueColumns(rows: Array<Record<string, unknown>>) {
  return Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
}

function push(values: unknown[], value: unknown) {
  values.push(value);
  return values.length;
}

function selectList(columns: string) {
  if (columns.trim() === "*") return "*";
  return columns
    .split(",")
    .map((column) => quoteIdent(column.trim()))
    .join(", ");
}

function quoteIdent(identifier: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Identificador invalido: ${identifier}`);
  }

  return `"${identifier}"`;
}

function normalizeRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((row) => normalizeValue(row) as T);
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeValue(item)]));
  }

  return value;
}
