import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from './api';

/** The snapshot every gamified surface reads — one request, one shape. */
export interface GamificationSnapshot {
  xp: number;
  coins: number;
  coinsEarned: number;
  coinsSpent: number;
  level: {
    level: number;
    nameAr: string;
    nameEn: string;
    icon: string;
    xpIntoLevel: number;
    xpForNext: number;
    pct: number;
    nextLevel: { level: number; nameAr: string; nameEn: string } | null;
  };
  streak: { current: number; longest: number; freezes: number; atRisk: boolean };
  weeklyGoal: { target: number; done: number; pct: number };
  stats: {
    lessonsCompleted: number;
    quizzesPassed: number;
    perfectQuizzes: number;
    coursesCompleted: number;
    assignmentsDone: number;
    liveAttended: number;
    certificates: number;
    quizAccuracy: number | null;
    activeCourses: number;
  };
  rank: {
    weekly: number;
    weeklyXp: number;
    division: string;
    divisionIcon: string;
    best: number | null;
  };
  activeTitle: string | null;
  titles: { key: string; labelAr: string; labelEn: string; icon: string }[];
  achievements: {
    earned: number;
    total: number;
    recent: { key: string; icon: string; titleAr: string; titleEn: string; unlockedAt: string }[];
  };
  missions: Mission[];
}

export interface Mission {
  id: string;
  kind: 'DAILY' | 'WEEKLY';
  template: string;
  target: number;
  progress: number;
  xpReward: number;
  coinReward: number;
  completed: boolean;
}

export interface AchievementRow {
  key: string;
  category: string;
  icon: string;
  titleAr: string;
  titleEn: string;
  descAr: string;
  descEn: string;
  threshold: number;
  progress: number;
  earned: boolean;
  unlockedAt: string | null;
  xpReward: number;
  coinReward: number;
}

export interface LeaderboardRow {
  rank: number;
  studentId: string;
  name: string;
  avatarUrl: string | null;
  level: number;
  xp: number;
  title: string | null;
  isMe: boolean;
}

export interface LeaderboardBoard {
  top: LeaderboardRow[];
  me: LeaderboardRow | null;
  around: LeaderboardRow[];
  total: number;
  toNextRank: number | null;
}

/**
 * What the engine reports back when an action earned something. Arrives
 * attached to the response of the action itself, so a lesson or a quiz can be
 * celebrated in the same round trip rather than after a refetch.
 */
export interface GamificationOutcome {
  awarded: boolean;
  xp: number;
  coins: number;
  totalXp: number;
  level: number;
  leveledUp: boolean;
  levelNameAr?: string;
  levelNameEn?: string;
  achievements: {
    key: string;
    icon: string;
    titleAr: string;
    titleEn: string;
    xpReward: number;
    coinReward: number;
  }[];
  missions: { id: string; template: string; kind: string; xpReward: number; coinReward: number }[];
}

export const GAMIFICATION_KEY = ['gamification'] as const;

export function useGamification(enabled = true) {
  return useQuery<GamificationSnapshot>({
    queryKey: GAMIFICATION_KEY,
    queryFn: async () => (await api.get('/student/gamification')).data,
    enabled,
    staleTime: 30_000,
  });
}

/**
 * Pick the right language out of the bilingual fields the API returns.
 * Falls back to the other language rather than rendering an empty string.
 */
export function useLocalized() {
  const { i18n } = useTranslation();
  const ar = i18n.language !== 'en';
  return (pair: { ar?: string | null; en?: string | null } | null | undefined): string => {
    if (!pair) return '';
    const first = ar ? pair.ar : pair.en;
    const second = ar ? pair.en : pair.ar;
    return (first?.trim() || second?.trim() || '') as string;
  };
}

/** Short number for tight spaces: 1200 → 1.2k. */
export function compactNum(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
}
