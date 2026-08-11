import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Role } from '@darsly/shared-types';
import { arrivalAcademy, clearArrival, rememberArrival } from '../lib/arrival';
import { useAcademyBranding, useMyAcademies } from '../lib/academy';
import { applyTheme, hasServerTheme, rememberedTheme } from '../lib/theme';
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
 *   - a student sees the academy they study at — the first one they enrolled
 *     with, which is the teacher who brought them here.
 *   - a visitor who has not signed in yet sees the academy they arrived
 *     through. They are usually mid-way through a teacher's funnel, and the
 *     sign-in screen is the last step of it, not the first step of ours.
 *   - someone whose session just expired keeps the colours they were already
 *     looking at. Signing out is not a reason to repaint the screen under
 *     someone's eyes, and they are about to sign back into the same academy.
 *   - a super admin is never themed. They move between academies all day, and a
 *     console that repaints itself would misreport whose data is on screen.
 *
 * A draft never counts. `brandTokens` is written at publish, so previewing a
 * design the teacher has not accepted leaves the console alone.
 */
export default function BrandTheme() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === Role.SUPER_ADMIN;
  const { pathname } = useLocation();
  const { data } = useMyAcademies();

  // Both the storefront and the teacher's course gallery identify the academy in
  // the path, and both are where a visitor lands from a published site. Held as
  // state as well as in storage: reading storage during render would not notice
  // the write below, so the branding query would stay disabled until some
  // unrelated re-render happened to pick it up.
  const [arrival, setArrival] = useState<string | null>(() => arrivalAcademy());
  useEffect(() => {
    const match = pathname.match(/^\/(?:a|t)\/([^/]+)/);
    if (!match) return;
    const slug = decodeURIComponent(match[1]);
    rememberArrival(slug);
    setArrival(arrivalAcademy());
  }, [pathname]);

  // Only fetched while signed out — once there is an account, what the person
  // actually belongs to is a better answer than where they came from.
  const { data: arrived, isFetched: arrivalSettled } = useAcademyBranding(
    user ? undefined : (arrival ?? undefined),
  );

  useEffect(() => {
    if (isAdmin) {
      applyTheme(null);
      return;
    }
    if (!user) {
      // Signing out has to drop the account's colours, but not the ones the
      // visitor arrived with — the login screen still belongs to that teacher.
      if (arrived?.appTheme) applyTheme(arrived.appTheme);
      // Nothing is cleared while the answer is still in flight. The server may
      // already have painted this page in the right colours, and clearing would
      // reintroduce exactly the flash the injection removes.
      else if (!arrival || arrivalSettled) {
        // A session that expires drops the user onto the sign-in screen without
        // a page load. Clearing here snapped a dark, gold console back to
        // platform indigo mid-glance — the one moment the app changes colour
        // while the person is already looking at it. So the last theme is kept:
        // signing back in lands on the same palette, and nothing flashes.
        //
        // Left alone when the server painted the page: it knows which academy
        // this URL is for, and the cache only knows which one came before.
        if (!hasServerTheme()) applyTheme(rememberedTheme());
      }
      return;
    }
    if (!data) return; // Keep whatever `bootTheme` replayed until the list lands.
    // `/me/academies` puts memberships first and then the academies the user
    // studies at, oldest enrolment first — so the first row is the teacher the
    // app belongs to, whether that is their own academy or the one they joined.
    applyTheme(data[0]?.branding?.appTheme ?? null);
    // Where they came from has served its purpose once an account exists.
    if (data.length) {
      clearArrival();
      setArrival(null);
    }
  }, [user, isAdmin, data, arrival, arrived, arrivalSettled]);

  return null;
}
