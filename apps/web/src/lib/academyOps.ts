import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export interface RosterStudent {
  id: string;
  fullName: string;
  email: string | null;
  avatarUrl: string | null;
  groups: { id: string; name: string }[];
  enrollmentsCount: number;
  isActive: boolean;
  joinedAt: string | null;
  lastActivityAt: string | null;
}
export interface RosterResult {
  total: number;
  page: number;
  pageSize: number;
  students: RosterStudent[];
}

export interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: string;
  studentsCount: number;
  staff: { role: 'TEACHER' | 'ASSISTANT'; name: string }[];
}
export interface GroupsResult {
  total: number;
  page: number;
  pageSize: number;
  groups: GroupRow[];
}

export interface GroupMember {
  membershipId: string;
  addedAt: string;
  studentId: string;
  fullName: string;
  email: string | null;
  avatarUrl: string | null;
}
export interface GroupAssignmentRow {
  assignmentId: string;
  role: 'TEACHER' | 'ASSISTANT';
  userId: string;
  fullName: string;
  email: string | null;
  avatarUrl: string | null;
}
export interface GroupDetail {
  id: string;
  name: string;
  description: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: string;
  members: GroupMember[];
  assignments: GroupAssignmentRow[];
}

export interface AttendanceStudent {
  studentId: string;
  fullName: string;
  avatarUrl: string | null;
  status: 'PRESENT' | 'ABSENT' | 'LATE' | 'EXCUSED' | null;
}
export interface AttendanceSessionResult {
  sessionId: string | null;
  date: string;
  students: AttendanceStudent[];
}

export interface NeedsAttentionResult {
  repeatedAbsences: { studentId: string; fullName: string; groupId: string; groupName: string; streak: number }[];
  inactiveStudents: { studentId: string; fullName: string; lastActivityAt: string | null }[];
  staleGroups: { groupId: string; name: string; lastSessionAt: string | null }[];
}

export function useRoster(params: { search?: string; page?: number; pageSize?: number }) {
  return useQuery<RosterResult>({
    queryKey: ['teacher-roster', params],
    queryFn: async () => (await api.get('/teacher/roster', { params: { ...params, page: params.page ?? 1, pageSize: params.pageSize ?? 20 } })).data,
    placeholderData: (prev) => prev,
  });
}

export function useGroups(params: { page?: number; pageSize?: number }) {
  return useQuery<GroupsResult>({
    queryKey: ['teacher-groups', params],
    queryFn: async () => (await api.get('/teacher/groups', { params: { page: params.page ?? 1, pageSize: params.pageSize ?? 20 } })).data,
    placeholderData: (prev) => prev,
  });
}

export function useCreateGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (dto: { name: string; description?: string }) => (await api.post('/teacher/groups', dto)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teacher-groups'] }),
  });
}

export function useGroupDetail(groupId: string | undefined) {
  return useQuery<GroupDetail>({
    queryKey: ['teacher-group', groupId],
    queryFn: async () => (await api.get(`/teacher/groups/${groupId}`)).data,
    enabled: !!groupId,
  });
}

export function useUpdateGroup(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (dto: { name?: string; description?: string; status?: 'ACTIVE' | 'ARCHIVED' }) =>
      (await api.patch(`/teacher/groups/${groupId}`, dto)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['teacher-group', groupId] });
      qc.invalidateQueries({ queryKey: ['teacher-groups'] });
    },
  });
}

export function useAddGroupMembers(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (studentIds: string[]) => (await api.post(`/teacher/groups/${groupId}/members`, { studentIds })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teacher-group', groupId] }),
  });
}

export function useRemoveGroupMember(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (studentId: string) => (await api.delete(`/teacher/groups/${groupId}/members/${studentId}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teacher-group', groupId] }),
  });
}

export function useUnassignStaff(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => (await api.delete(`/teacher/groups/${groupId}/assignments/${userId}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teacher-group', groupId] }),
  });
}

export function useAttendanceSession(groupId: string | undefined, date: string) {
  return useQuery<AttendanceSessionResult>({
    queryKey: ['teacher-attendance', groupId, date],
    queryFn: async () => (await api.get(`/teacher/groups/${groupId}/attendance`, { params: { date } })).data,
    enabled: !!groupId && !!date,
  });
}

export function useMarkAttendance(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (dto: { date: string; records: { studentId: string; status: string }[] }) =>
      (await api.post(`/teacher/groups/${groupId}/attendance`, dto)).data,
    onSuccess: (_data, dto) => qc.invalidateQueries({ queryKey: ['teacher-attendance', groupId, dto.date] }),
  });
}

export function useNeedsAttention() {
  return useQuery<NeedsAttentionResult>({
    queryKey: ['teacher-needs-attention'],
    queryFn: async () => (await api.get('/teacher/needs-attention')).data,
  });
}
