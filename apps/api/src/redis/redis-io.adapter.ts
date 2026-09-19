import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { ServerOptions } from 'socket.io';
import { RedisService } from './redis.service';

/**
 * Fans Socket.IO rooms and broadcasts out across every Railway replica via
 * Redis pub/sub, instead of each instance only knowing about the sockets
 * connected to it. Without this, a chat message sent by a user landed on
 * instance A silently never reaches a recipient whose socket landed on
 * instance B — confirmed live in production (two replicas, default in-memory
 * adapter) before this fix.
 *
 * Preserves everything about the existing gateway: this only changes how
 * `emit`/`to(room)` reach sockets on other processes. Authentication
 * (ChatGateway's handshake JWT check), room-join authorization, and every
 * event handler are untouched.
 *
 * Fails OPEN: if Redis is unreachable at startup, the adapter is never
 * attached and Socket.IO keeps Nest's default in-memory adapter — sockets on
 * a single instance keep working exactly as before this change; only the
 * cross-replica fan-out is missing, i.e. today's status quo, not a new
 * failure mode. The app is never blocked from booting over this.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private redisAdapter: ReturnType<typeof createAdapter> | null = null;

  constructor(private readonly app: INestApplicationContext) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const redis = this.app.get(RedisService);
    const pub = redis.duplicate();
    if (!pub) {
      this.logger.warn(
        'REDIS_URL not set — Socket.IO stays on the default in-memory adapter (correct for one instance, not for >1 replica).',
      );
      return;
    }
    const sub = pub.duplicate();
    try {
      await Promise.all([pub.connect().catch(() => undefined), sub.connect().catch(() => undefined)]);
      // ioredis with lazyConnect resolves connect() even on failure until a
      // command actually runs; a cheap PING confirms the pair is really live
      // before wiring the adapter in.
      await pub.ping();
      await sub.ping();
      this.redisAdapter = createAdapter(pub, sub);
      this.logger.log('Socket.IO Redis adapter connected — rooms now fan out across replicas.');
    } catch (e) {
      this.logger.error(
        `Socket.IO Redis adapter connection failed, continuing without it (per-instance only): ${(e as Error).message}`,
      );
      pub.disconnect();
      sub.disconnect();
    }
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, options);
    if (this.redisAdapter) {
      server.adapter(this.redisAdapter);
    }
    return server;
  }
}
