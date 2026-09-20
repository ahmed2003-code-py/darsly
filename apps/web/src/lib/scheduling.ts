import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export interface Room {
  id: string;
  name: string;
  location: string | null;
  capacity: number | null;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: string;
}

export interface ScheduleSession {
  id: string;
  startAt: string;
  endAt: string;
  status: 'SCHEDULED' | 'CANCELLED' | 'COMPLETED';
  group: { id: string; name: string };
  room: { id: string; name: string } | null;
  teacher: { id: string; fullName: string } | null;
}

export interface ConflictErrorBody {
  message: string;
  code: 'ROOM_CONFLICT' | 'TEACHER_CONFLICT' | 'GROUP_CONFLICT';
  conflictingSessionId?: string;
}

export function useRooms() {
  return useQuery<Room[]>({
    queryKey: ['teacher-rooms'],
    queryFn: async () => (await api.get('/teacher/rooms')).data,
  });
}

export function useCreateRoom() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (dto: { name: string; location?: string; capacity?: number }) => (await api.post('/teacher/rooms', dto)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teacher-rooms'] }),
  });
}

export function useUpdateRoom() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ roomId, ...dto }: { roomId: string; name?: string; location?: string; capacity?: number; status?: 'ACTIVE' | 'ARCHIVED' }) =>
      (await api.patch(`/teacher/rooms/${roomId}`, dto)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teacher-rooms'] }),
  });
}

/** The schedule endpoint is slug-addressed (any academy member, not just
 *  staff) — this resolves the caller's own home academy slug, same ordering
 *  convention BrandTheme.tsx relies on (isHome first). */
export function useMyHomeAcademySlug() {
  const { data } = useQuery<{ slug: string }[]>({
    queryKey: ['my-academies'],
    queryFn: async () => (await api.get('/me/academies')).data,
    staleTime: 5 * 60_000,
  });
  return data?.[0]?.slug;
}

export function useSchedule(slug: string | undefined, from: string, to: string) {
  return useQuery<ScheduleSession[]>({
    queryKey: ['schedule', slug, from, to],
    queryFn: async () => (await api.get(`/academies/${slug}/schedule`, { params: { from, to } })).data,
    enabled: !!slug,
  });
}

export function useCreateSession(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (dto: { roomId?: string; teacherUserId?: string; startAt: string; endAt: string }) =>
      (await api.post(`/teacher/groups/${groupId}/sessions`, dto)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedule'] }),
  });
}

export function useUpdateSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, ...dto }: { sessionId: string; roomId?: string; teacherUserId?: string; startAt?: string; endAt?: string; status?: 'SCHEDULED' | 'CANCELLED' | 'COMPLETED' }) =>
      (await api.patch(`/teacher/sessions/${sessionId}`, dto)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedule'] }),
  });
}

export function useCancelSession() {
  const update = useUpdateSession();
  return { ...update, mutate: (sessionId: string) => update.mutate({ sessionId, status: 'CANCELLED' }) };
}
