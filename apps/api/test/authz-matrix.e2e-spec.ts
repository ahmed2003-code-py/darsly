import { Controller, Get, INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Role } from '@darsly/shared-types';
import request from 'supertest';
import { Public } from '../src/common/decorators/public.decorator';
import { Roles } from '../src/common/decorators/roles.decorator';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * The guard chain, over real HTTP.
 *
 * `npm run test:e2e` pointed at a config that did not exist and a directory
 * that had never been created, so supertest sat in the manifest unused and
 * **no test anywhere crossed the HTTP boundary**. Every authorization test in
 * this repository called a service directly — which cannot see guard ordering,
 * cannot tell a 401 from a 403, and cannot notice a route that forgot
 * `@Roles`.
 *
 * This boots a real Nest application with the real `JwtAuthGuard` and
 * `RolesGuard` wired as `APP_GUARD` in the same order `app.module.ts` wires
 * them, and drives it with supertest. It deliberately does not boot the whole
 * AppModule: that needs Postgres, Redis and the full config validation, and
 * the thing worth testing here is the guard composition, not the 41 modules
 * behind it. Prisma is stubbed to exactly the one lookup the guard performs.
 */
const SECRET = 'e2e-access-secret-at-least-32-characters-long';

@Controller('probe')
class ProbeController {
  @Public()
  @Get('open')
  open() {
    return { seen: 'anyone' };
  }

  @Get('any-authenticated')
  authed() {
    return { ok: true };
  }

  @Roles(Role.TEACHER)
  @Get('teacher-only')
  teacher() {
    return { ok: true };
  }

  @Roles(Role.STUDENT)
  @Get('student-only')
  student() {
    return { ok: true };
  }

  @Roles(Role.TEACHER, Role.STAFF)
  @Get('teacher-or-staff')
  teacherOrStaff() {
    return { ok: true };
  }

  @Roles(Role.SUPER_ADMIN)
  @Get('admin-only')
  admin() {
    return { ok: true };
  }
}

describe('authorization matrix (e2e)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  let session: { revokedAt: Date | null; user: { isActive: boolean } } | null;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET = SECRET;
    session = { revokedAt: null, user: { isActive: true } };

    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: SECRET, signOptions: { algorithm: 'HS256' } })],
      controllers: [ProbeController],
      providers: [
        Reflector,
        { provide: PrismaService, useValue: { deviceSession: { findUnique: async () => session } } },
        // The same order app.module.ts declares: authenticate, then authorize.
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    jwt = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    session = { revokedAt: null, user: { isActive: true } };
  });

  const tokenFor = (role: Role) => jwt.sign({ sub: `u-${role}`, role, sessionId: 's1' });
  const as = (role: Role) => ({ Authorization: `Bearer ${tokenFor(role)}` });

  describe('unauthenticated', () => {
    it('reaches a @Public route', () =>
      request(app.getHttpServer()).get('/probe/open').expect(200, { seen: 'anyone' }));

    it('is refused everywhere else with 401, not 403', () =>
      request(app.getHttpServer()).get('/probe/any-authenticated').expect(401));

    it('is 401 on a role-gated route too — identity is decided before permission', () =>
      request(app.getHttpServer()).get('/probe/teacher-only').expect(401));
  });

  describe('a malformed or forged token', () => {
    it('is refused', () =>
      request(app.getHttpServer())
        .get('/probe/any-authenticated')
        .set('Authorization', 'Bearer not-a-token')
        .expect(401));

    it('signed with the wrong secret is refused', () => {
      const forged = new JwtService({ secret: 'a-completely-different-secret-value-32' }).sign({
        sub: 'u1',
        role: Role.SUPER_ADMIN,
        sessionId: 's1',
      });
      return request(app.getHttpServer())
        .get('/probe/admin-only')
        .set('Authorization', `Bearer ${forged}`)
        .expect(401);
    });
  });

  /**
   * The distinction a service-level test cannot make: authenticated but not
   * allowed is 403, not 401. Answering 401 would tell a signed-in user to sign
   * in again, which they cannot fix.
   */
  describe('the matrix', () => {
    const cases: [string, Role, number][] = [
      ['/probe/teacher-only', Role.TEACHER, 200],
      ['/probe/teacher-only', Role.STUDENT, 403],
      ['/probe/teacher-only', Role.STAFF, 403],
      ['/probe/student-only', Role.STUDENT, 200],
      ['/probe/student-only', Role.TEACHER, 403],
      ['/probe/teacher-or-staff', Role.TEACHER, 200],
      ['/probe/teacher-or-staff', Role.STAFF, 200],
      ['/probe/teacher-or-staff', Role.STUDENT, 403],
      ['/probe/admin-only', Role.SUPER_ADMIN, 200],
      ['/probe/admin-only', Role.TEACHER, 403],
      ['/probe/admin-only', Role.STUDENT, 403],
      ['/probe/any-authenticated', Role.STUDENT, 200],
    ];

    it.each(cases)('%s as %s -> %i', (path, role, status) =>
      request(app.getHttpServer()).get(path).set(as(role)).expect(status),
    );
  });

  /**
   * Documented behaviour of RolesGuard, pinned so it cannot change silently:
   * SUPER_ADMIN passes every role check. That is a deliberate product
   * decision, and a test is the right place for it to be visible.
   */
  describe('SUPER_ADMIN', () => {
    it.each(['/probe/teacher-only', '/probe/student-only', '/probe/teacher-or-staff'])(
      'passes %s without holding that role',
      (path) => request(app.getHttpServer()).get(path).set(as(Role.SUPER_ADMIN)).expect(200),
    );
  });

  describe('session revocation, enforced at the edge', () => {
    it('a revoked device is refused even with a valid, unexpired token', () => {
      session = { revokedAt: new Date(), user: { isActive: true } };
      return request(app.getHttpServer()).get('/probe/any-authenticated').set(as(Role.TEACHER)).expect(401);
    });

    it('a disabled account is refused', () => {
      session = { revokedAt: null, user: { isActive: false } };
      return request(app.getHttpServer()).get('/probe/any-authenticated').set(as(Role.TEACHER)).expect(401);
    });

    it('a session that no longer exists is refused', () => {
      session = null;
      return request(app.getHttpServer()).get('/probe/any-authenticated').set(as(Role.TEACHER)).expect(401);
    });

    it('a revoked device still reaches @Public routes — public means public', () => {
      session = { revokedAt: new Date(), user: { isActive: true } };
      return request(app.getHttpServer()).get('/probe/open').set(as(Role.TEACHER)).expect(200);
    });
  });
});
