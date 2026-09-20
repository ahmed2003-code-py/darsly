import { SetMetadata } from '@nestjs/common';
import type { FeatureFlagKey } from './feature-flags.service';

export const FEATURE_FLAG_KEY = 'academy_feature_flag';

/** Requires a named feature to be enabled for the resolved academy
 *  (FeatureFlagGuard). Must run after AcademyMembershipGuard, which
 *  populates req.academyContext. */
export const RequireFeature = (key: FeatureFlagKey) => SetMetadata(FEATURE_FLAG_KEY, key);
