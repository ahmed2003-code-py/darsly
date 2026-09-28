import axios from 'axios';
import { useAuthStore } from '../stores/auth';
import { useStaffAcademyStore } from '../stores/staffAcademy';
import { isGuest, renewGuestToken } from './guest';

// Production build is served by the API itself -> same-origin relative calls.
// Local dev (vite on :5173) talks to the API on :4000 unless VITE_API_URL says otherwise.
const API_ORIGIN =
  import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:4000' : '');

/** Absolute API origin — needed for URLs handed to hls.js / <a download> that
 *  bypass the axios client (must resolve to the API, not the web origin). */
export function apiOrigin(): string {
  return API_ORIGIN || window.location.origin;
}

export const api = axios.create({
  baseURL: `${API_ORIGIN}/api/v1`,
});

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  // The active workspace, for every staff identity. A selector only — the
  // server authorizes from the membership, never from this header. See
  // stores/staffAcademy.ts. Never overrides a header a caller already set.
  const staffAcademyId = useStaffAcademyStore.getState().academyId;
  if (staffAcademyId && !config.headers['X-Academy-Id']) {
    config.headers['X-Academy-Id'] = staffAcademyId;
  }
  return config;
});

// Transparent refresh: on 401, rotate the refresh token once and retry.
let refreshing: Promise<string | null> | null = null;

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;
    const { refreshToken, setTokens, clear } = useAuthStore.getState();
    // A guest has no refresh token: its classroom token is renewed from the
    // purchase's access secret, and only while the seat is still active.
    if (error.response?.status === 401 && isGuest() && !original._retried) {
      original._retried = true;
      const fresh = await renewGuestToken(api.defaults.baseURL as string);
      if (fresh) {
        original.headers.Authorization = `Bearer ${fresh}`;
        return api(original);
      }
      return Promise.reject(error);
    }
    if (error.response?.status === 401 && refreshToken && !original._retried) {
      original._retried = true;
      refreshing ??= axios
        .post(`${api.defaults.baseURL}/auth/refresh`, { refreshToken })
        .then(({ data }) => {
          setTokens(data.accessToken, data.refreshToken);
          return data.accessToken as string;
        })
        .catch(() => {
          clear();
          return null;
        })
        .finally(() => {
          refreshing = null;
        });
      const newToken = await refreshing;
      if (newToken) {
        original.headers.Authorization = `Bearer ${newToken}`;
        return api(original);
      }
    }
    return Promise.reject(error);
  },
);

/**
 * A media URL the API handed out (signed avatar / attachment links). They are
 * root-relative (`/api/v1/files/…`) when the API does not know its public
 * origin, which only resolves on the same origin as the API — so resolve them
 * against the API origin, exactly like requests are.
 */
export function mediaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.startsWith('/') ? `${apiOrigin()}${url}` : url;
}
