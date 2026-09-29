/**
 * Runs in each Jest worker before any spec module loads: point DATABASE_URL at
 * this worker's own database (created by global-setup.js). A worker runs one
 * file at a time, so no two specs ever share a database concurrently.
 */
const prefix = process.env.DARSLY_TEST_DB_PREFIX;
if (prefix && process.env.DATABASE_URL) {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${prefix}_w${process.env.JEST_WORKER_ID || '1'}`;
  process.env.DATABASE_URL = url.toString();
}
