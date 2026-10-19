import pg from 'pg';

// Return DATE columns as 'YYYY-MM-DD' strings instead of JS Dates,
// so party dates never shift because of time zone conversion.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);
// Return NUMERIC as a JS number (only used for small values like duration_hours).
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number(value));

export type Db = pg.Pool;

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
}
