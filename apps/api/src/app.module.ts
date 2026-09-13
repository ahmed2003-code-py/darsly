import { existsSync } from 'fs';
import { join } from 'path';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from './audit/audit.module';
import { AcademyThemeMiddleware } from './branding/academy-theme.middleware';
import { AuthModule } from './auth/auth.module';
import { CatalogModule } from './catalog/catalog.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { PrismaService } from './prisma/prisma.service';
import { ChatModule } from './chat/chat.module';
import { CoursesModule } from './courses/courses.module';
import { EnrollmentsModule } from './enrollments/enrollments.module';
import { HealthController } from './health/health.controller';
import { MailModule } from './mail/mail.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PaymentsModule } from './payments/payments.module';
import { WalletModule } from './wallet/wallet.module';
import { PayoutsModule } from './payouts/payouts.module';
import { AdminModule } from './admin/admin.module';
import { SecurityModule } from './security/security.module';
import { AssessmentsModule } from './assessments/assessments.module';
import { ReviewsModule } from './reviews/reviews.module';
import { LiveModule } from './live/live.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { StudentExtrasModule } from './student/student-extras.module';
import { ProfileModule } from './profile/profile.module';
import { PlaybackModule } from './playback/playback.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProgressModule } from './progress/progress.module';
import { RealtimeModule } from './realtime/realtime.module';
import { StorageModule } from './storage/storage.module';
import { TeachersModule } from './teachers/teachers.module';
import { UploadsModule } from './uploads/uploads.module';
import { AcademyModule } from './academy/academy.module';
import { AcademySiteModule } from './academy-site/academy-site.module';
import { DeviceModule } from './device/device.module';
import { GamificationModule } from './gamification/gamification.module';

// Single-service deploys: when the web app has been built into apps/web/dist,
// the API serves it too (SPA fallback included). API routes stay under /api.
const webDist = join(__dirname, '..', '..', 'web', 'dist');
/** Vite writes every built asset as `name-<hash>.ext` under /assets. */
const HASHED_ASSET = /[\\/]assets[\\/].+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    ...(existsSync(webDist)
      ? [
          ServeStaticModule.forRoot({
            rootPath: webDist,
            exclude: ['/api/(.*)'],
            serveStaticOptions: {
              // Everything under /assets carries a content hash in its name, so
              // the file at a given URL can never change: cache it for a year
              // and a returning visitor fetches nothing. index.html is the
              // opposite — it is the map to those names, and a stale copy is
              // exactly how a phone ends up asking for a chunk a deploy has
              // already replaced, which is what "something went wrong" was.
              setHeaders(res, path) {
                res.setHeader(
                  'Cache-Control',
                  HASHED_ASSET.test(path)
                    ? 'public, max-age=31536000, immutable'
                    : 'no-cache',
                );
              },
            },
          }),
        ]
      : []),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule,
    MailModule,
    AuditModule,
    AuthModule,
    CatalogModule,
    TeachersModule,
    CoursesModule,
    StorageModule,
    UploadsModule,
    EnrollmentsModule,
    PlaybackModule,
    NotificationsModule,
    ChatModule,
    RealtimeModule,
    ProgressModule,
    GamificationModule,
    PaymentsModule,
    WalletModule,
    PayoutsModule,
    AdminModule,
    SecurityModule,
    AssessmentsModule,
    ReviewsModule,
    LiveModule,
    AnalyticsModule,
    StudentExtrasModule,
    ProfileModule,
    AcademyModule,
    AcademySiteModule,
    DeviceModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: authenticate first, then authorize.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  constructor(private readonly prisma: PrismaService) {}

  configure(consumer: MiddlewareConsumer): void {
    // Only meaningful in a single-service deploy, where this process is also the
    // one handing out the app's HTML.
    if (!existsSync(webDist)) return;
    const middleware = new AcademyThemeMiddleware(this.prisma, join(webDist, 'index.html'));
    // Ahead of the static handler, and past the API: a page load for an academy
    // is answered with that academy's colours already in the document, so the
    // first paint is right instead of being corrected a second later.
    consumer
      .apply((req: never, res: never, next: never) => middleware.use(req, res, next))
      .exclude('api/(.*)')
      .forRoutes('*');
  }
}
