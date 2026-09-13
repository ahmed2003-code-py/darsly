import { Role } from '@darsly/shared-types';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { releaseStudio } from '../lib/studio';

export interface AuthUser {
  id: string;
  role: Role;
  fullName: string;
  phone?: string;
  email?: string;
  avatarUrl?: string;
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
  setTokens: (access: string, refresh: string) => void;
  setUser: (user: AuthUser) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      setTokens: (accessToken, refreshToken) => set({ accessToken, refreshToken }),
      setUser: (user) => set({ user }),
      clear: () => {
        // The look stays. Whoever just signed out is usually about to sign back
        // in, and snapping their Darsly to their teacher's colours mid-glance is
        // the one moment the app repaints while somebody is looking at it. A
        // different account arriving is a different moment, and `claimStudio`
        // drops the old look then — before that account's own is fetched, so
        // nobody ever sees a stranger's colours.
        releaseStudio();
        set({ accessToken: null, refreshToken: null, user: null });
      },
    }),
    { name: 'darsly-auth' },
  ),
);
