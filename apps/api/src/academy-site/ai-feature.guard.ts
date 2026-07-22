import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { AcademySiteConfig } from './academy-site.config';

/**
 * Kill-switch guard for Academy Studio routes. When AI_ACADEMY_ENABLED is off,
 * studio endpoints behave as if they do not exist (404) — a clean way to roll
 * the feature out gradually and to disable it instantly without a redeploy.
 * The public media/site read routes are intentionally NOT behind this guard.
 */
@Injectable()
export class AiFeatureEnabledGuard implements CanActivate {
  constructor(private readonly config: AcademySiteConfig) {}

  canActivate(): boolean {
    if (!this.config.enabled) throw new NotFoundException('Not found');
    return true;
  }
}
