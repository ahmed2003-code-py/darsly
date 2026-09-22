import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChallengeAnswerReveal,
  ChallengeRandomize,
  ChallengeScoring,
  ChallengeType,
} from '@darsly/shared-types';
import { api } from './api';
import { GamificationOutcome } from './gamification';

/** Mirrors the API's Challenge shape — see apps/api/prisma/schema.prisma. */
export interface ChallengeSettings {
  title: string;
  description: string;
  coverIcon: string;
  type: ChallengeType;
  difficulty: number;
  courseId: string | null;
  subjectId: string | null;
  gradeId: string | null;
  topic: string | null;
  durationSec: number | null;
  questionTimeSec: number | null;
  scoring: ChallengeScoring;
  maxAttempts: number;
  leaderboardEnabled: boolean;
  answerReveal: ChallengeAnswerReveal;
  randomize: ChallengeRandomize;
}

export interface ChallengeQuestionRow {
  id?: string;
  type: 'MCQ' | 'TRUE_FALSE';
  prompt: string;
  imageUrl: string | null;
  options: { id: string; text: string }[];
  correctOptionIds: string[];
  explanation: string;
  points: number;
  timeLimitSec: number | null;
  topic: string | null;
  difficulty: number;
}

export interface TeacherChallenge extends ChallengeSettings {
  id: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ACTIVE' | 'CLOSED' | 'ARCHIVED';
  questionCount: number;
  attemptCount: number;
  createdAt: string;
  publishedAt: string | null;
}

export interface TeacherChallengeDetail extends TeacherChallenge {
  questions: ChallengeQuestionRow[];
}

export interface StudentChallengeCard {
  id: string;
  title: string;
  coverIcon: string;
  type: ChallengeType;
  difficulty: number;
  questionCount: number;
  durationSec: number | null;
  teacherName: string;
  topic: string | null;
  bestScore: number | null;
  inProgress: boolean;
  attemptsRemaining: number | null;
  canPlay: boolean;
}

export interface ChallengeDetail {
  id: string;
  title: string;
  description: string;
  coverIcon: string;
  type: ChallengeType;
  difficulty: number;
  questionCount: number;
  durationSec: number | null;
  questionTimeSec: number | null;
  scoring: ChallengeScoring;
  leaderboardEnabled: boolean;
  maxAttempts: number;
  attemptsUsed: number;
  attemptsRemaining: number | null;
  openAttemptId: string | null;
  bestScore: number | null;
}

export interface PlayQuestion {
  id: string;
  index: number;
  type: 'MCQ' | 'TRUE_FALSE';
  prompt: string;
  imageUrl: string | null;
  options: { id: string; text: string }[];
  timeLimitSec: number | null;
  /** Base XP if answered correctly — drives the live "worth N XP" ticker. */
  points: number;
}

export interface AttemptState {
  attemptId: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'TIMED_OUT' | 'ABANDONED';
  startedAt: string;
  deadlineAt: string | null;
  serverNow: string;
  totalQuestions: number;
  /** How many questions this attempt has already answered — where a
   *  refresh/reconnect resumes, not necessarily 0. */
  answeredCount: number;
  questions: PlayQuestion[];
}

export interface AnswerFeedback {
  questionId: string;
  isCorrect: boolean;
  xpAwarded: number;
  correctOptionIds?: string[];
  explanation?: string;
}

export interface MistakeRow {
  questionId: string;
  prompt: string;
  yourAnswer: string[];
  correctOptionIds: string[];
  isCorrect: boolean;
  explanation: string;
  topic: string | null;
}

export interface ChallengeResult {
  attemptId: string;
  status: string;
  score: number;
  correctCount: number;
  wrongCount: number;
  accuracyPct: number | null;
  speedPct: number | null;
  xpAwarded: number;
  coinsAwarded: number;
  rank: number | null;
  gamification: GamificationOutcome | null;
  mistakes: MistakeRow[];
  review: MistakeRow[];
}

export interface ChallengeLeaderboardRow {
  rank: number;
  studentId: string;
  name: string;
  avatarUrl: string | null;
  score: number;
  accuracyPct: number | null;
  isMe: boolean;
}

// ── Teacher ──────────────────────────────────────────────────────────────

export function useTeacherChallenges(status?: string) {
  return useQuery<TeacherChallenge[]>({
    queryKey: ['teacher-challenges', status],
    queryFn: async () => (await api.get('/teacher/challenges', { params: status ? { status } : {} })).data,
  });
}

export function useTeacherChallenge(id: string | undefined) {
  return useQuery<TeacherChallengeDetail>({
    queryKey: ['teacher-challenge', id],
    queryFn: async () => (await api.get(`/teacher/challenges/${id}`)).data,
    enabled: !!id,
  });
}

export function useChallengeSubmissions(id: string | undefined) {
  return useQuery({
    queryKey: ['teacher-challenge-submissions', id],
    queryFn: async () => (await api.get(`/teacher/challenges/${id}/submissions`)).data,
    enabled: !!id,
  });
}

export function useChallengeAnalytics(id: string | undefined) {
  return useQuery({
    queryKey: ['teacher-challenge-analytics', id],
    queryFn: async () => (await api.get(`/teacher/challenges/${id}/analytics`)).data,
    enabled: !!id,
  });
}

export function useSaveChallengeQuestions(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (questions: ChallengeQuestionRow[]) =>
      (await api.put(`/teacher/challenges/${id}/questions`, { questions })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teacher-challenge', id] }),
  });
}

// ── Student ──────────────────────────────────────────────────────────────

export function useStudentChallenges(tab: 'available' | 'in_progress' | 'completed') {
  return useQuery<StudentChallengeCard[]>({
    queryKey: ['student-challenges', tab],
    queryFn: async () => (await api.get('/challenges', { params: { tab } })).data,
  });
}

export function useChallengeDetail(id: string | undefined) {
  return useQuery<ChallengeDetail>({
    queryKey: ['student-challenge', id],
    queryFn: async () => (await api.get(`/challenges/${id}`)).data,
    enabled: !!id,
  });
}

