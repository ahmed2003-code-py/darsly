import { Role } from '@darsly/shared-types';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { forgetUserData } from '../lib/queryClient';
import { releaseStudio } from '../lib/studio';
import { useStaffAcademyStore } from './staffAcademy';

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
      setUser: (user) => {
        // Belt and braces: a *different* person arriving drops whatever the
        // last one left, even if nothing ever called `clear()` — a tab that was
        // signed in when the tokens were replaced, a refresh that resolved into
        // another session. Same person signing back in keeps their cache.
        const previous = useAuthStore.getState().user;
        if (previous && previous.id !== user.id) {
          forgetUserData();
          useStaffAcademyStore.getState().clear();
        }
        set({ user });
      },
      clear: () => {
        // The look stays. Whoever just signed out is usually about to sign back
        // in, and snapping their Darsly to their teacher's colours mid-glance is
        // the one moment the app repaints while somebody is looking at it. A
        // different account arriving is a different moment, and `claimStudio`
        // drops the old look then — before that account's own is fetched, so
        // nobody ever sees a stranger's colours.
        releaseStudio();
        useStaffAcademyStore.getState().clear();
        set({ accessToken: null, refreshToken: null, user: null });
        // Everything else this person left behind. The look above is the one
        // exception, and it is kept on purpose; the react-query cache is the
        // one that mattered — `['wallet']` is keyed by what it fetches and
        // never by whose it is, so the next account to sign in was handed the
        // last one's balance out of memory before any request went out.
        forgetUserData();
      },
    }),
    { name: 'darsly-auth' },
  ),
);
