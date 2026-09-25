import { useCloudflareMeeting } from './useCloudflareMeeting';
import { useDailyMeeting } from './useDailyMeeting';

export type LiveProvider = 'daily' | 'cloudflare';

/**
 * The classroom's media, whichever provider carries this class.
 *
 * The server decides the provider — per class, fixed when it was created — and
 * says so in the join answer (`meeting.provider`). Until that answer arrives
 * neither adapter starts anything; after it, only the one that matches does.
 * Both hooks are always called (hooks cannot be chosen conditionally); the
 * other one stays inert.
 */
export function useLiveMeeting(
  liveSessionId: string,
  provider: LiveProvider | null,
  opts: {
    onTiming?: (timing: { startedAt: string | null; endsAt: string; serverNow: string }) => void;
  } = {},
) {
  const daily = useDailyMeeting(liveSessionId, { ...opts, enabled: provider === 'daily' });
  const cloudflare = useCloudflareMeeting(liveSessionId, {
    ...opts,
    enabled: provider === 'cloudflare',
  });
  return provider === 'cloudflare' ? cloudflare : daily;
}

export type LiveMeeting = ReturnType<typeof useLiveMeeting>;
