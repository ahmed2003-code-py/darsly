import { useEffect } from 'react';
import { Role } from '@darsly/shared-types';
import { useMyAcademies } from '../lib/academy';
import { applyTheme } from '../lib/theme';
import { useAuthStore } from '../stores/auth';

/**
 * Decides which academy's colours the app wears, and keeps that decision in one
 * place. Renders nothing.
 *
 * Who gets themed follows from who the app belongs to at that moment:
 *
 *   - a teacher and their staff see their own academy, from the moment they
 *     publish it. That is the whole point: the console stops looking like the
 *     platform and starts looking like the thing they built.
 *   - a student sees their home academy. A student can be enrolled with several
 *     teachers, so the shell follows the one membership marked `isHome` rather
 *     than picking arbitrarily among them.
 *   - a super admin is never themed. They move between academies all day, and a
 *     console that repaints itself would misreport whose data is on screen.
 *
 * A draft never counts. `brandTokens` is written at publish, so previewing a
 * design the teacher has not accepted leaves the console alone.
 */
export default function BrandTheme() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === Role.SUPER_ADMIN;
  const { data } = useMyAcademies();

  useEffect(() => {
    if (!user || isAdmin) {
      applyTheme(null);
      return;
    }
    if (!data) return; // Keep whatever `bootTheme` replayed until the list lands.
    // `/me/academies` is ordered home-first, so the first row is the academy the
    // app belongs to for both a teacher (their own) and a student (their home).
    applyTheme(data[0]?.branding?.appTheme ?? null);
  }, [user, isAdmin, data]);

  // Signing out has to strip the colours immediately — the login screen belongs
  // to the platform, not to whoever used the browser last.
  useEffect(() => {
    if (!user) applyTheme(null);
  }, [user]);

  return null;
}
