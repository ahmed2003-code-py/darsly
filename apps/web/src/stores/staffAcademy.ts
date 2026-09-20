import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Which academy a non-owner staff member (TEACHER/ASSISTANT membership, not
 * OWNER) is currently acting in.
 *
 * An academy OWNER never needs this: their JWT already carries `tenantId`
 * (their own TeacherProfile.id), so every `/teacher/*` call resolves their
 * academy automatically — see AcademyService.resolveAcademyId's JWT
 * fallback. A staff member who is NOT an owner has no such tenantId (it's
 * only ever set from the caller's own TeacherProfile), so without this
 * store every `/teacher/*` call for them had nothing to resolve an academy
 * from and 404'd — the actual cause of a real bug found 2026-09-20.
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
