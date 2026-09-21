import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export interface InvitationLink {
  id: string;
  role: 'TEACHER' | 'ASSISTANT';
  status: 'PENDING' | 'USED' | 'REVOKED' | 'EXPIRED';
  expiresAt: string;
  createdAt: string;
}
export interface CreatedInvitationLink extends Pick<InvitationLink, 'id' | 'role' | 'expiresAt' | 'createdAt'> {
  /** Only ever present in this one response — never fetched again. */
  token: string;
}
export interface InvitationPreview {
  academyName: string;
  role: 'TEACHER' | 'ASSISTANT';
  expiresAt: string;
}

const key = (slug: string) => ['academy-invitation-links', slug];

export function useInvitationLinks(slug: string) {
  return useQuery<InvitationLink[]>({
    queryKey: key(slug),
    queryFn: async () => (await api.get(`/academies/${slug}/invitation-links`)).data,
  });
}

export function useCreateInvitationLink(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (role: 'TEACHER' | 'ASSISTANT') =>
      (await api.post<CreatedInvitationLink>(`/academies/${slug}/invitation-links`, { role })).data,
    onSuccess: () => { void qc.invalidateQueries({ queryKey: key(slug) }); },
  });
}

export function useRevokeInvitationLink(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.delete(`/academies/${slug}/invitation-links/${id}`)).data,
    onSuccess: () => { void qc.invalidateQueries({ queryKey: key(slug) }); },
  });
}

export function invitationJoinUrl(token: string): string {
  return `${window.location.origin}/join/${encodeURIComponent(token)}`;
}

export function useInvitationPreview(token: string | undefined) {
  return useQuery<InvitationPreview>({
    queryKey: ['invitation-link-preview', token],
    queryFn: async () => (await api.get(`/invitation-links/${token}`)).data,
    enabled: !!token,
    retry: false,
  });
}

export function useAcceptInvitationLink() {
  return useMutation({
    mutationFn: async (token: string) => (await api.post(`/invitation-links/${token}/accept`)).data,
  });
}
