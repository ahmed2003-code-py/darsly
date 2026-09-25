import { LiveProvider, LiveProviderKind } from './live-provider';

/**
 * Which provider carries which class.
 *
 * Two rules, and the second matters more:
 *  - a *new* class goes to the configured default (LIVE_PROVIDER);
 *  - a class keeps the provider it was created with, for life. The column is
 *    written once, when the session is created, so changing LIVE_PROVIDER
 *    moves tomorrow's classes and never one already scheduled or running. Rows
 *    from before the column existed are Daily's — that is what they ran on.
 */
export class LiveProviders {
  private readonly byKind = new Map<LiveProviderKind, LiveProvider>();

  constructor(
    providers: LiveProvider[],
    readonly defaultKind: LiveProviderKind,
  ) {
    for (const p of providers) this.byKind.set(p.kind, p);
    if (!this.byKind.has(defaultKind)) {
      throw new Error(`LIVE_PROVIDER=${defaultKind.toLowerCase()} has no provider registered`);
    }
  }

  get(kind: LiveProviderKind): LiveProvider {
    const p = this.byKind.get(kind);
    if (!p) throw new Error(`No live provider registered for ${kind}`);
    return p;
  }

  forSession(s: { provider?: LiveProviderKind | string | null }): LiveProvider {
    return this.get((s.provider as LiveProviderKind | null | undefined) ?? 'DAILY');
  }

  get default(): LiveProvider {
    return this.get(this.defaultKind);
  }

  all(): LiveProvider[] {
    return [...this.byKind.values()];
  }
}

/**
 * LIVE_PROVIDER, read once at boot: `cloudflare` (the default) or `daily`.
 * Anything else is a typo that would otherwise pick a provider silently.
 */
export function liveProviderFromEnv(env: NodeJS.ProcessEnv = process.env): LiveProviderKind {
  const raw = (env.LIVE_PROVIDER ?? '').trim().toLowerCase();
  if (!raw || raw === 'cloudflare') return 'CLOUDFLARE';
  if (raw === 'daily') return 'DAILY';
  throw new Error(
    `LIVE_PROVIDER="${env.LIVE_PROVIDER}" is not a live provider (cloudflare | daily)`,
  );
}
