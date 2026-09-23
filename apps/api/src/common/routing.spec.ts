import { Controller, Get, INestApplication, VERSION_NEUTRAL, Version } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureRouting } from './routing';

/**
 * The URLs are a contract, not an implementation detail.
 *
 * The web app, the Android app and every generated academy page hold
 * `/api/v1/...` paths. Moving the version out of the prefix string and into
 * Nest's versioning is meant to change nothing a client can observe, so the
 * point of this file is to prove that rather than reason about it: the same
 * paths still answer, the unversioned and unprefixed forms still do not, and
 * the capability that was the reason for the change actually works.
 */
@Controller('probe')
class ProbeController {
  @Get('thing')
  thing() {
    return { v: 1 };
  }

  /** The thing the old prefix string could not express. */
  @Version('2')
  @Get('thing')
  thingV2() {
    return { v: 2 };
  }

  @Version(VERSION_NEUTRAL)
  @Get('always')
  always() {
    return { v: 'neutral' };
  }
}

describe('API routing', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    app = moduleRef.createNestApplication();
    configureRouting(app); // exactly what main.ts applies
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('the paths clients already hold', () => {
    it('answers on /api/v1/... exactly as the old prefix string did', () =>
      request(app.getHttpServer()).get('/api/v1/probe/thing').expect(200, { v: 1 }));

    it('does not answer without the version', () =>
      request(app.getHttpServer()).get('/api/probe/thing').expect(404));

    it('does not answer without the prefix', () =>
      request(app.getHttpServer()).get('/probe/thing').expect(404));

    it('does not invent a bare /v1 route outside the prefix', () =>
      request(app.getHttpServer()).get('/v1/probe/thing').expect(404));
  });

  describe('what the change was for', () => {
    it('lets one handler answer v2 while its sibling keeps v1', async () => {
      await request(app.getHttpServer()).get('/api/v2/probe/thing').expect(200, { v: 2 });
      await request(app.getHttpServer()).get('/api/v1/probe/thing').expect(200, { v: 1 });
    });

    it('lets a route opt out of versioning entirely', () =>
      request(app.getHttpServer()).get('/api/probe/always').expect(200, { v: 'neutral' }));

    it('refuses a version that does not exist, rather than falling back to v1', () =>
      request(app.getHttpServer()).get('/api/v9/probe/thing').expect(404));
  });
});
