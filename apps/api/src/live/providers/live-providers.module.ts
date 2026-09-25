import { Logger, Module } from '@nestjs/common';
import { DailyService } from '../daily.service';
import { CloudflareLiveProvider } from './cloudflare-live.provider';
import { CloudflareRealtimeClient } from './cloudflare-realtime.client';
import { DailyLiveProvider } from './daily-live.provider';
import { LiveProviders, liveProviderFromEnv } from './live-providers';

/**
 * The registry, built once at boot — and the boot fails if the configured
 * provider cannot run a class. Cloudflare selected without its credentials is
 * a deployment mistake, and quietly carrying classes on Daily instead would
 * hide it until someone read the bill; so the process refuses to start and
 * says which variables are missing. (Skipped under NODE_ENV=test, where specs
 * build the registry themselves.)
 */
export function buildLiveProviders(
  daily: DailyLiveProvider,
  cloudflare: CloudflareLiveProvider,
  env: NodeJS.ProcessEnv = process.env,
): LiveProviders {
  const kind = liveProviderFromEnv(env);
  if (kind === 'CLOUDFLARE' && !cloudflare.configured && env.NODE_ENV !== 'test') {
    throw new Error(
      'LIVE_PROVIDER is cloudflare (the default) but CF_REALTIME_APP_ID / CF_REALTIME_APP_SECRET ' +
        'are not set. Set them, or set LIVE_PROVIDER=daily to run classes on Daily.',
    );
  }
  const log = new Logger('LiveProviders');
  log.log(
    `live provider for new classes: ${kind.toLowerCase()} ` +
      `(cloudflare ${cloudflare.configured ? 'configured' : 'not configured'}, ` +
      `TURN ${cloudflare.client.turnConfigured ? 'configured' : 'not configured — STUN only'}; ` +
      `daily ${daily.configured ? 'configured' : 'not configured'})`,
  );
  return new LiveProviders([daily, cloudflare], kind);
}

/**
 * The video providers on their own, so two modules can reach them without
 * reaching each other: the classroom needs them to open rooms, and the summary
 * job needs them to fetch a transcript. Without this they would import one
 * another, and this codebase has no `forwardRef` anywhere.
 */
@Module({
  providers: [
    DailyService,
    DailyLiveProvider,
    CloudflareRealtimeClient,
    CloudflareLiveProvider,
    {
      provide: LiveProviders,
      useFactory: (daily: DailyLiveProvider, cloudflare: CloudflareLiveProvider) =>
        buildLiveProviders(daily, cloudflare),
      inject: [DailyLiveProvider, CloudflareLiveProvider],
    },
  ],
  exports: [LiveProviders, CloudflareLiveProvider],
})
export class LiveProvidersModule {}
