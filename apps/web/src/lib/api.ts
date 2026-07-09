import axios from 'axios';
import { useAuthStore } from '../stores/auth';

// Production build is served by the API itself -> same-origin relative calls.
// Local dev (vite on :5173) talks to the API on :4000 unless VITE_API_URL says otherwise.
const API_ORIGIN = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:4000' : '');

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
  return config;
});

// Transparent refresh: on 401, rotate the refresh token once and retry.
let refreshing: Promise<string | null> | null = null;

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;
    const { refreshToken, setTokens, clear } = useAuthStore.getState();
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
