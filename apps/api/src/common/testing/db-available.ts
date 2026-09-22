import type { PrismaService } from '../../prisma/prisma.service';

/**
 * Is there a database these tests can actually run against?
 *
 * Integration suites skip themselves when no database is reachable, so the
 * suite stays green on a laptop without one and in CI. The probe they used was
 * `$connect()` followed by a `count()` — which answers "is something
 * listening", and nothing else.
 *
 * That is the wrong question, and it failed in exactly the predictable way: a
 * database that was running but behind on migrations passed the probe, then
 * every test failed with `The column User.adminThemePreference does not exist
 * in the current database`. Ten red tests describing a developer's local setup
 * rather than the code.
 *
 * `findFirst()` with no arguments selects every scalar column the generated
 * client believes the model has. If the migration adding one has not been
 * applied, it throws here — where it is caught and turned into a skip with a
 * message that says what to do. And because it asks for whatever the schema
 * currently declares, it keeps working as the schema grows; nothing has to be
 * remembered.
 *
 * Pass the models the suite genuinely writes to. Probing a model it never
 * touches would skip the suite for drift that could not have affected it.
 */
export async function databaseReady(
  prisma: PrismaService,
  models: readonly string[],
): Promise<boolean> {
  try {
    await prisma.$connect();
    for (const model of models) {
      const delegate = (prisma as unknown as Record<string, { findFirst?: () => Promise<unknown> }>)[model];
      if (!delegate?.findFirst) throw new Error(`unknown model "${model}"`);
      await delegate.findFirst();
    }
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `skipping integration suite — database not usable at DATABASE_URL: ${(e as Error).message}\n` +
        '  (if it is running, it is probably behind on migrations: npx prisma migrate deploy)',
    );
    return false;
  }
}
