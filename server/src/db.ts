import { Pool, PoolClient, QueryResultRow, types } from 'pg';
import { databaseUrl } from './env';

// Return DATE columns as plain 'YYYY-MM-DD' strings instead of local-midnight Date objects.
types.setTypeParser(1082, (v: string) => v);

export const pool = new Pool({ connectionString: databaseUrl, max: 10 });

export type Db = Pool | PoolClient;

export async function q<T extends QueryResultRow = any>(text: string, params: unknown[] = [], db: Db = pool): Promise<T[]> {
  const res = await db.query<T>(text, params as any[]);
  return res.rows;
}

export async function one<T extends QueryResultRow = any>(text: string, params: unknown[] = [], db: Db = pool): Promise<T | null> {
  const rows = await q<T>(text, params, db);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function waitForDb(retries = 30): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('select 1');
      return;
    } catch (e) {
      console.log(`Waiting for database... (${i + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('Database not reachable');
}
