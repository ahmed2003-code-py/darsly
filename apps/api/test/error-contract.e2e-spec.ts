import {
  Body,
  ConflictException,
  Controller,
  Get,
  INestApplication,
  NotFoundException,
  Post,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { json } from 'express';
import request from 'supertest';
import { ApiExceptionFilter } from '../src/common/errors/api-exception.filter';
import { bodyParserErrors } from '../src/common/errors/body-parser-errors';
import { VALIDATION_PIPE_OPTIONS } from '../src/common/errors/validation-exception.factory';
import { requestIdMiddleware } from '../src/common/request-context';

/**
 * The error contract over real HTTP: the request-id middleware, the body
 * parser, the validation pipe, the throttler and the filter wired the way
 * main.ts and app.module.ts wire them. Every response below is what a browser
 * would actually receive.
 */

class GuardianDto {
  @IsString() @MinLength(2) @MaxLength(80) name: string;
  @IsString() @Matches(/^01[0125]\d{8}$/) phone: string;
  @IsIn(['FATHER', 'MOTHER']) relationship: string;
}

@Controller('probe')
class ProbeController {
  @Post('guardians')
  add(@Body() dto: GuardianDto) {
    return dto;
  }

  @Get('conflict')
  conflict() {
    throw new ConflictException({
      code: 'PHONE_IN_USE',
      message: 'This phone number already belongs to another Darsly account',
      field: 'phone',
    });
  }

  @Get('hidden')
  hidden() {
    throw new NotFoundException('Student not found');
  }

  @Get('unauthenticated')
  unauth() {
    throw new UnauthorizedException();
  }

  @Get('crash')
  crash() {
    throw new Error('ECONNREFUSED 10.0.0.5:5432 user=postgres password=secret');
  }

  @Get('constraint')
  constraint() {
    throw new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`phone`) in table "User"',
      { code: 'P2002', clientVersion: '5.22.0', meta: { target: ['phone'] } },
    );
  }

  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  @Get('limited')
  limited() {
    return { ok: true };
  }
}

describe('error contract (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 1000 }] })],
      controllers: [ProbeController],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
      ],
    }).compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    nest.use(requestIdMiddleware);
    nest.use(json({ limit: '1kb' }));
    nest.use(bodyParserErrors);
    nest.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    nest.useLogger(false);
    app = await nest.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());

  it('a bad form comes back field by field, with stable codes', async () => {
    const res = await http()
      .post('/probe/guardians')
      .send({ name: 'A', phone: '12345', relationship: 'UNCLE', extra: 1 })
      .expect(400);
    expect(res.body).toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_FAILED',
      retryable: false,
      requestId: expect.any(String),
    });
    expect(res.body.fields).toEqual(
      expect.arrayContaining([
        { field: 'name', code: 'TOO_SHORT', params: { min: 2 } },
        { field: 'phone', code: 'INVALID_PHONE' },
        { field: 'relationship', code: 'INVALID_CHOICE' },
        { field: 'extra', code: 'UNKNOWN_FIELD' },
      ]),
    );
  });

  it('a business refusal keeps its code and field', async () => {
    const res = await http().get('/probe/conflict').expect(409);
    expect(res.body).toMatchObject({ code: 'PHONE_IN_USE', field: 'phone', retryable: false });
  });

  it('a hiding 404 stays a neutral 404', async () => {
    const res = await http().get('/probe/hidden').expect(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND', message: 'Student not found' });
  });

  it('401 carries UNAUTHENTICATED', async () => {
    const res = await http().get('/probe/unauthenticated').expect(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('a crash is a safe 500 whose reference id matches the header', async () => {
    const res = await http().get('/probe/crash').expect(500);
    expect(res.body).toEqual({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      retryable: true,
      requestId: res.headers['x-request-id'],
    });
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|postgres|secret|5432/);
  });

  it('a database constraint never names the table or column', async () => {
    const res = await http().get('/probe/constraint').expect(409);
    expect(res.body.code).toBe('ALREADY_EXISTS');
    expect(JSON.stringify(res.body)).not.toMatch(/phone|User|Unique|P2002/);
  });

  it('malformed JSON is a JSON 400, not an HTML error page', async () => {
    const res = await http()
      .post('/probe/guardians')
      .set('Content-Type', 'application/json')
      .send('{"name": ')
      .expect(400);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toMatchObject({ code: 'MALFORMED_BODY', requestId: expect.any(String) });
  });

  it('an oversized body is a JSON 413', async () => {
    const res = await http()
      .post('/probe/guardians')
      .send({ name: 'x'.repeat(5000) })
      .expect(413);
    expect(res.body).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', retryable: false });
  });

  it('rate limiting says so, and says for how long', async () => {
    await http().get('/probe/limited').expect(200);
    await http().get('/probe/limited').expect(200);
    const res = await http().get('/probe/limited').expect(429);
    expect(res.body).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(Number(res.headers['retry-after'])).toBe(res.body.retryAfterSeconds);
  });
});
