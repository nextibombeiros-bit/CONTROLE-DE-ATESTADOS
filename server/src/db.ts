import { readFile } from "node:fs/promises";
import path from "node:path";
import { PgCompatClient } from "./pg-compat.js";

export function createDb() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL nao configurada");
  }

  return PgCompatClient.fromConnectionString(databaseUrl);
}

export async function runMigrations(db: PgCompatClient) {
  const shouldRun = process.env.RUN_MIGRATIONS !== "false";
  if (!shouldRun) return;

  const schemaPath = path.join(process.cwd(), "server", "sql", "001_schema.sql");
  const sql = await readFile(schemaPath, "utf8");
  await db.query(sql);
}
