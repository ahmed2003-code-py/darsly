import { DailyService } from '../daily.service';
import { DailyLiveProvider } from './daily-live.provider';
import { LiveProviders } from './live-providers';

/** Specs: a registry with Daily only, over a mocked DailyService. */
export function dailyProviders(daily: unknown): LiveProviders {
  return new LiveProviders([new DailyLiveProvider(daily as DailyService)], 'DAILY');
}
