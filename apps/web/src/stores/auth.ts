import { Role } from '@darsly/shared-types';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { clearStudio } from '../lib/studio';

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
        // The next person to sign in on this device is not this one, and their
        // Darsly should not open wearing somebody else's colours.
        clearStudio();
        set({ accessToken: null, refreshToken: null, user: null });
      },
    }),
    { name: 'darsly-auth' },
  ),
);
