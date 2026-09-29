import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { JSON_BODY_LIMIT } from './common/validation';
import { AppLogger } from './common/app-logger';
import { validateConfig } from './common/config.validation';
import { VALIDATION_PIPE_OPTIONS } from './common/errors/validation-exception.factory';
import { requestIdMiddleware } from './common/request-context';
import { configureRouting } from './common/routing';
import { RedisIoAdapter } from './redis/redis-io.adapter';

async function bootstrap() {
  // Fail fast on forgeable secrets / dev backdoors before anything binds a port.
  validateConfig();

  const isProd = process.env.NODE_ENV === 'production';
  // Attaches the request id to every line, and in production emits JSON so the
  // logs can be queried rather than grepped. See common/app-logger.ts.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new AppLogger(),
  });

  /**
   * First middleware, before anything can log.
   *
   * Ahead of helmet and the body parsers on purpose: a request rejected by one
   * of those is exactly the kind that needs an id, and middleware registered
   * later would never see it.
   */
  app.use(requestIdMiddleware);

  // Production sits entirely behind Railway's edge — nothing reaches this
  // process except through it, so trusting the whole X-Forwarded-For chain is
  // safe (there is no direct-internet path a client could use to spoof it).
  // Without this, Express reads req.ip from the raw TCP peer, which is
  // Railway's own proxy layer, not the real client — and login rate limiting
  // is keyed on it. Confirmed live: x-ratelimit-remaining on 5 consecutive
  // requests from the same client read 15, 19, 17, 16, 19 — non-monotonic,
  // proving each request was being tracked as a different identity, so no
  // single one ever reached the limit. This was the actual cause of the
  // "rate limiter never blocks in production" bug — Redis was never the
  // problem.
  app.set('trust proxy', true);

  // Baseline security headers (HSTS, X-Content-Type-Options, frame-deny, etc.).
  // contentSecurityPolicy is disabled: the API also serves the built SPA and an
  // over-strict default CSP would break it — the SPA sets its own policy. crossOrigin
  // resource policy is relaxed so signed HLS media can be consumed by the player.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // Images (avatars, course thumbnails, payment-proof photos) arrive as base64
  // data URLs inside JSON. Express defaults to a 100 KB body, which rejected a
  // resized receipt photo with a bare 413 BEFORE any DTO ran — so the per-field
  // MaxLength caps were never the real boundary. Set the transport limit above
  // the largest field cap; validation, not body-parser, decides what's too big.
  app.use(json({ limit: JSON_BODY_LIMIT }));
  app.use(urlencoded({ limit: JSON_BODY_LIMIT, extended: true }));

  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim());
  // X-Request-Id and Retry-After are read by the web's error resolver (the
  // reference number on an unexpected error, the wait on a 429). Same-origin
  // in production; exposed so a cross-origin dev setup behaves the same.
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
  });

  configureRouting(app);
  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));

  // Rooms/broadcasts fan out across every Railway replica via Redis pub/sub —
  // see redis/redis-io.adapter.ts. Falls open to the default in-memory
  // adapter (single-instance-only fan-out, same as before this change) if
  // Redis is unreachable, rather than failing to boot.
  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  // Swagger exposes the full endpoint surface (incl. every /admin route). Serve the
  // interactive docs in non-production only; production keeps the API surface unlisted.
  if (!isProd) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Darsly API')
      .setDescription(
        'Arabic-first EdTech marketplace API. Multi-tenant: teacher-owned resources are scoped by tenantId. ' +
          'Phase 3 adds encrypted-HLS video: uploads are transcoded to AES-128 HLS, delivered through ' +
          'short-lived signed URLs with a per-session gated key, forensic watermarking, and playback ' +
          'session/anomaly control (tag: playback).',
      )
      .setVersion('0.6.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
  }

  /**
   * A clean stop is an exit 0.
   *
   * Railway sends SIGTERM to the outgoing deployment on every redeploy. Nest's
   * own `enableShutdownHooks()` runs the hooks and then RE-RAISES the signal on
   * itself, so even a perfect shutdown ended as "killed by SIGTERM" (143) —
   * and the container's main process was `npm`, which exits 143 at once
   * without waiting for the app. Railway records a non-zero exit as CRASHED:
   * every deploy raised a CRITICAL "crashed" event for the deployment being
   * replaced, while the video/AI worker drains (onModuleDestroy) never ran.
   *
   * Here `app.close()` runs the same hooks (destroy → beforeShutdown →
   * shutdown), then the process exits 0. A close that hangs past the deadline
   * exits 1 — an honest failure, not a hidden one. The start command runs node
   * directly (railway.json), so this handler is what receives the signal.
   */
  const SHUTDOWN_DEADLINE_MS = 25_000;
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    // eslint-disable-next-line no-console
    console.log(`${signal} received — closing (deadline ${SHUTDOWN_DEADLINE_MS} ms)`);
    const deadline = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.error(`shutdown did not finish within ${SHUTDOWN_DEADLINE_MS} ms — exiting 1`);
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref();
    const started = Date.now();
    app.close().then(
      () => {
        // eslint-disable-next-line no-console
        console.log(`closed cleanly in ${Date.now() - started} ms — exiting 0`);
        process.exit(0);
      },
      (e: unknown) => {
        // eslint-disable-next-line no-console
        console.error('shutdown failed — exiting 1', e);
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  // PORT is injected by PaaS hosts (Railway/Heroku); API_PORT is the local dev var.
  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Darsly API listening on http://localhost:${port} — docs at /api/docs`);
}

bootstrap();
