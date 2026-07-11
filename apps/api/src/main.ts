import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim());
  app.enableCors({ origin: allowedOrigins, credentials: true });

  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Darsly API')
    .setDescription(
      'Arabic-first EdTech marketplace API. Multi-tenant: teacher-owned resources are scoped by tenantId. ' +
        'Phase 3 adds encrypted-HLS video: uploads are transcoded to AES-128 HLS, delivered through ' +
        'short-lived signed URLs with a per-session gated key, forensic watermarking, and playback ' +
        'session/anomaly control (tag: playback).',
    )
    .setVersion('0.5.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  // PORT is injected by PaaS hosts (Railway/Heroku); API_PORT is the local dev var.
  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Darsly API listening on http://localhost:${port} — docs at /api/docs`);
}

bootstrap();
