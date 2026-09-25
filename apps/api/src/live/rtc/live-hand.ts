import type { LiveHandState } from '@prisma/client';

/**
 * The raise-hand flow, as the server enforces it.
 *
 *   IDLE ──raise──▶ HAND_RAISED ──approve──▶ APPROVED_TO_SPEAK ──publish──▶ ACTIVE_SPEAKER
 *     ▲                │  reject/lower            │ revoke/lower              │ revoke/lower
 *     └────────────────┘                          ▼                           ▼
 *                                              RELEASED ◀─────────────────────┘
 *   RELEASED ──raise──▶ HAND_RAISED  (a student may ask again)
 *
 * The browser shows this and never decides it. A student can open a sending
 * connection and push audio or video only while APPROVED_TO_SPEAK or
 * ACTIVE_SPEAKER — checked by the server on every push — and a revoke closes
 * whatever they were sending at the SFU, whatever their browser does next.
 */
export type HandAction = 'raise' | 'lower' | 'approve' | 'reject' | 'revoke' | 'published';

const TRANSITIONS: Record<HandAction, Partial<Record<LiveHandState, LiveHandState>>> = {
  raise: { IDLE: 'HAND_RAISED', RELEASED: 'HAND_RAISED' },
  lower: {
    HAND_RAISED: 'IDLE',
    APPROVED_TO_SPEAK: 'RELEASED',
    ACTIVE_SPEAKER: 'RELEASED',
  },
  approve: { HAND_RAISED: 'APPROVED_TO_SPEAK' },
  reject: { HAND_RAISED: 'IDLE' },
  revoke: { APPROVED_TO_SPEAK: 'RELEASED', ACTIVE_SPEAKER: 'RELEASED' },
  published: { APPROVED_TO_SPEAK: 'ACTIVE_SPEAKER' },
};

/** Who may take which action: the student on their own hand, the teacher on anyone's. */
export const STUDENT_ACTIONS: readonly HandAction[] = ['raise', 'lower'];
export const TEACHER_ACTIONS: readonly HandAction[] = ['approve', 'reject', 'revoke'];

/** The next state, or null when the action does not apply from `from`. */
export function nextHandState(from: LiveHandState, action: HandAction): LiveHandState | null {
  return TRANSITIONS[action][from] ?? null;
}

/** The states from which `action` applies — for a compare-and-set update. */
export function handStatesFor(action: HandAction): LiveHandState[] {
  return Object.keys(TRANSITIONS[action]) as LiveHandState[];
}

export function canSpeak(state: LiveHandState | null | undefined): boolean {
  return state === 'APPROVED_TO_SPEAK' || state === 'ACTIVE_SPEAKER';
}
