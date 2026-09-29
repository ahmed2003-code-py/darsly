/**
 * Under REQUIRE_TEST_DB=1 (CI) a spec may not skip itself for want of a
 * database. Every DB-backed spec's guard() prints this warning and returns
 * early — which Jest counts as a pass. Here that warning throws instead, so
 * the test fails with the reason. (One suite reported its own broken seed as
 * "no database" this way, and never ran anywhere.)
 */
if (process.env.REQUIRE_TEST_DB === '1') {
  const warn = console.warn.bind(console);
  console.warn = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('skipping: no database reachable')) {
      throw new Error(`REQUIRE_TEST_DB=1 but the spec skipped: ${args[0]}`);
    }
    warn(...args);
  };
}
