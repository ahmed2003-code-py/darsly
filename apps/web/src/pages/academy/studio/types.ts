export interface Social {
  platform: string;
  url: string;
}

export interface Facts {
  fullName: string | null;
  bio: string | null;
  subjects: string[];
  stages: string[];
  achievements: string[];
  socials: Social[];
  rawIntake: string | null;
}

export type SiteStatus = 'DRAFT' | 'PENDING_MODERATION' | 'PUBLISHED' | 'REJECTED';

export interface SiteOverview {
  status: SiteStatus;
  hasDraft: boolean;
  publishedAt: string | null;
  version: number;
  moderationApproved: boolean;
  moderationReason: string | null;
  lastJob: { id: string; status: string; stage: string | null } | null;
  /** Quality-gate result for the current draft: errors block a publish. */
  quality: { errors: string[]; warnings: string[] } | null;
  /** One line from the designer on why the page looks the way it does. */
  rationale: string | null;
}

export type MediaKind = 'LOGO' | 'COVER' | 'GALLERY' | 'AVATAR';
export type MediaStatus = 'UPLOADING' | 'PROCESSING' | 'READY' | 'REJECTED';

export interface Media {
  id: string;
  kind: MediaKind;
  status: MediaStatus;
  url: string | null;
  width: number | null;
  height: number | null;
  rejectReason: string | null;
}
