import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { StorageProvider } from '../storage/storage.provider';

type Check = 'ok' | 'down' | 'not_configured';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly storage: StorageProvider,
  ) {}

  /**
   * Liveness: is this process answering?
   *
   * Deliberately checks nothing else. A platform restarts a container that
   * fails its liveness probe, so making this depend on Redis or on object
   * storage would turn one dependency's bad afternoon into a restart loop
   * across every replica — the outage amplified rather than contained.
   */
  @Public()
  @Get('live')
  @ApiOperation({ summary: 'Liveness — the process is up' })
  live() {
    return { status: 'ok', service: 'darsly-api', time: new Date().toISOString() };
  }

  /**
   * Readiness: should this replica be given traffic?
   *
   * This is where dependencies belong, because the answer is "send requests
   * elsewhere", not "kill it". Postgres is the only hard one: without it
   * essentially no endpoint can answer, so its failure is a 503.
   *
   * Redis and storage are reported but do not fail the check, and that is a
   * deliberate match to how the application already behaves. Redis failing
   * open is designed in — rate limiting stops enforcing and Socket.IO drops to
   * single-instance fan-out, both degraded rather than broken — so a replica
   * that can still serve every HTTP request should not be pulled out of
   * rotation. What was missing was not the failure mode but the *visibility*:
   * nothing anywhere said Redis was down, so the fail-open was silent.
   */
  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness — dependencies checked; 503 when the database is unusable' })
  async ready(@Res({ passthrough: true }) res: Response) {
    const [database, redis, storage] = await Promise.all([
      this.check(() => this.prisma.$queryRaw`SELECT 1`),
      this.checkRedis(),
      this.check(() => this.storage.exists('__healthcheck__')),
    ]);

    if (database !== 'ok') res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: database === 'ok' ? 'ok' : 'degraded',
      service: 'darsly-api',
      checks: { database, redis, storage },
      time: new Date().toISOString(),
    };
  }

  /**
   * The original endpoint, unchanged.
   *
   * Railway's healthcheck and anything else already pointed here, and a
   * deploy-time probe is not the place to discover a renamed path. It is
   * liveness plus the database, exactly as before.
   */
  @Public()
  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Health — process and database' })
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', service: 'darsly-api', time: new Date().toISOString() };
  }

  private async check(probe: () => Promise<unknown>): Promise<Check> {
    try {
      await probe();
      return 'ok';
    } catch {
      return 'down';
    }
  }

  /** Absent Redis is a valid local configuration, not a fault — say so rather than calling it down. */
  private async checkRedis(): Promise<Check> {
    if (!this.redis.client) return 'not_configured';
    return this.check(() => this.redis.client!.ping());
  }
}
