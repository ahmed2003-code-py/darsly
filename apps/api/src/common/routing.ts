import { INestApplication, VersioningType } from '@nestjs/common';

/**
 * Where every URL this API answers on is decided.
 *
 * It used to be one line — `setGlobalPrefix('api/v1')` — and that is the whole
 * of what "v1" meant: four characters inside a prefix string. Nest never knew a
 * version existed, so there was no way to add a v2 route beside a v1 one, and
 * no way to mark a route deprecated other than a comment. A version nobody can
 * increment is decoration.
 *
 * The prefix and the version are separated here so Nest owns the version. The
 * externally visible result is byte-identical — `api` + URI version `1` builds
 * `/api/v1/...`, the same strings as before, which routing.spec.ts asserts
 * rather than assumes, because every client and the Android app hold these
 * paths. What changes is only what is now *possible*: `@Version('2')` on a
 * single handler, or `VERSION_NEUTRAL` on one that must answer unversioned.
 *
 * Kept out of main.ts so a test can apply exactly what production applies. A
 * second copy of these two lines in a spec would prove only that the copy
 * works.
 */
export function configureRouting(app: INestApplication): void {
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
}
