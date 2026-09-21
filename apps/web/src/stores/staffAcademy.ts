import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * The active workspace: which academy the signed-in staff member (owner,
 * teacher or assistant) is currently acting in. Sent as X-Academy-Id on every
 * request by lib/api.ts.
 *
 * The header is a context SELECTOR, never an authorization: the server
 * resolves it to an academy and then decides from the caller's own ACTIVE
 * membership there (AcademyService.buildContext). A forged or stale id gets a
 * 404, nothing more. The JWT `tenantId` is the caller's own TeacherProfile
 * (authorship) and is never derived from, or overwritten by, this value.
 *
 * Read directly (not via the `useX()` hook) from lib/api.ts's request
 * interceptor, since that file runs outside React.
 */
interface StaffAcademyState {
  academyId: string | null;
  setAcademyId: (id: string | null) => void;
  clear: () => void;
}

export const useStaffAcademyStore = create<StaffAcademyState>()(
  persist(
    (set) => ({
      academyId: null,
      setAcademyId: (academyId) => set({ academyId }),
      clear: () => set({ academyId: null }),
    }),
    { name: 'darsly-staff-academy' },
  ),
);
