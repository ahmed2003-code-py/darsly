import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { JSON_BODY_LIMIT } from './common/validation';
import { validateConfig } from './common/config.validation';

async function bootstrap() {
  // Fail fast on forgeable secrets / dev backdoors before anything binds a port.
  validateConfig();

  const isProd = process.env.NODE_ENV === 'production';
  const app = await NestFactory.create(AppModule);

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
  app.enableCors({ origin: allowedOrigins, credentials: true });

  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

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

  // PORT is injected by PaaS hosts (Railway/Heroku); API_PORT is the local dev var.
  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Darsly API listening on http://localhost:${port} — docs at /api/docs`);
}

bootstrap();
