import axios from 'axios';
import { Role } from '@darsly/shared-types';
import { useAuthStore } from '../stores/auth';

/**
 * A guest's live seat, on this device.
 *
 * The access secret is the credential: it lives in the URL the guest keeps,
 * and — for this tab only — in sessionStorage, so the classroom can renew its
 * short-lived token without a refresh token (a guest never gets one). Nothing
 * here grants anything by itself: every token comes from the server, which
 * checks the seat each time.
 */
const SECRET_KEY = 'darsly-guest-secret';

export const isGuest = () => useAuthStore.getState().user?.role === Role.GUEST;

export function rememberGuestSecret(secret: string) {
  try {
    sessionStorage.setItem(SECRET_KEY, secret);
  } catch {
    /* private mode: the URL still works */
  }
}

export function guestSecret(): string | null {
  try {
    return sessionStorage.getItem(SECRET_KEY);
  } catch {
    return null;
  }
}

/** Where a guest belongs: their purchase's page (or nowhere, if this tab never had one). */
export function guestHome(): string {
  const s = guestSecret();
  return s ? `/live/access/${s}` : '/login';
}

/** Exchange the secret for a classroom token; returns the session it is for. */
export async function enterAsGuest(apiBase: string, secret: string): Promise<string> {
  const { data } = await axios.post(
    `${apiBase}/public/live/access/${encodeURIComponent(secret)}/classroom`,
  );
  rememberGuestSecret(secret);
  const store = useAuthStore.getState();
  store.setTokens(data.accessToken, '');
  store.setUser({ id: data.user.id, role: Role.GUEST, fullName: data.user.fullName });
  return data.liveSessionId as string;
}

/** A fresh classroom token for a guest whose token expired (null when the seat is no longer active). */
export async function renewGuestToken(apiBase: string): Promise<string | null> {
  const s = guestSecret();
  if (!s) return null;
  try {
    const { data } = await axios.post(
      `${apiBase}/public/live/access/${encodeURIComponent(s)}/classroom`,
    );
    useAuthStore.getState().setTokens(data.accessToken, '');
    return data.accessToken as string;
  } catch {
    return null;
  }
}
