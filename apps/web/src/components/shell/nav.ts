import { Role } from '@darsly/shared-types';

/**
 * Where each role can go. Data, so every navigation surface — sidebar, rail,
 * drawer, bottom tabs, a header that carries the nav when the sidebar is
 * hidden — is drawn from the same list and a renamed label cannot drift.
 */
export interface NavItem {
  to: string;
  icon: string;
  labelKey: string;
  /** A shorter name for the phone tab bar, where five labels share ~70px each. */
  shortLabelKey?: string;
  end?: boolean;
}

export const STUDENT_NAV: NavItem[] = [
  { to: '/', icon: 'space_dashboard', labelKey: 'nav.home', end: true },
  { to: '/courses', icon: 'auto_stories', labelKey: 'nav.browse' },
  { to: '/discover', icon: 'travel_explore', labelKey: 'nav.discover' },
  { to: '/my-courses', icon: 'menu_book', labelKey: 'nav.myCourses' },
  { to: '/learning', icon: 'trophy', labelKey: 'nav.learning' },
  { to: '/challenges', icon: 'social_leaderboard', labelKey: 'nav.challenges' },
  { to: '/studio', icon: 'palette', labelKey: 'nav.myStudio' },
  { to: '/wallet', icon: 'account_balance_wallet', labelKey: 'nav.wallet' },
  { to: '/saved', icon: 'favorite', labelKey: 'nav.saved' },
  { to: '/live', icon: 'sensors', labelKey: 'nav.live' },
  { to: '/my-certificates', icon: 'workspace_premium', labelKey: 'nav.certificates' },
  { to: '/messages', icon: 'forum', labelKey: 'nav.messages' },
];

export const TEACHER_NAV: NavItem[] = [
  { to: '/teacher', icon: 'space_dashboard', labelKey: 'nav.dashboard', end: true },
  { to: '/academy/studio', icon: 'auto_awesome', labelKey: 'nav.studio' },
  {
    to: '/teacher/courses',
    icon: 'video_library',
    labelKey: 'nav.courseBuilder',
    shortLabelKey: 'nav.short.courseBuilder',
  },
  { to: '/teacher/challenges', icon: 'social_leaderboard', labelKey: 'nav.challenges' },
  {
    to: '/teacher/students',
    icon: 'groups',
    labelKey: 'nav.myStudents',
    shortLabelKey: 'nav.short.myStudents',
  },
  { to: '/teacher/groups', icon: 'diversity_3', labelKey: 'nav.groups' },
  { to: '/teacher/schedule', icon: 'calendar_month', labelKey: 'nav.schedule' },
  { to: '/teacher/grading', icon: 'grading', labelKey: 'nav.grading' },
  { to: '/teacher/analytics', icon: 'monitoring', labelKey: 'nav.analytics' },
  { to: '/teacher/team', icon: 'support_agent', labelKey: 'nav.team' },
  { to: '/teacher/live', icon: 'sensors', labelKey: 'nav.live' },
  { to: '/messages', icon: 'forum', labelKey: 'nav.messages' },
  { to: '/teacher/wallet', icon: 'account_balance_wallet', labelKey: 'nav.wallet' },
  { to: '/teacher/security', icon: 'shield', labelKey: 'nav.security' },
  { to: '/teacher/coupons', icon: 'sell', labelKey: 'nav.coupons' },
];

/**
 * A Center's desk administers; it does not teach. The courses entry is here
 * because an owner must be able to see — and take off sale — everything the
 * Center offers, but it is named for what it is: oversight of a catalogue
 * other people wrote, not a builder.
 */
export const STAFF_NAV: NavItem[] = [
  { to: '/center', icon: 'apartment', labelKey: 'nav.centerDashboard', end: true },
  {
    to: '/center/members',
    icon: 'group',
    labelKey: 'nav.centerMembers',
    shortLabelKey: 'nav.short.centerMembers',
  },
  { to: '/teacher/team', icon: 'support_agent', labelKey: 'nav.team' },
  { to: '/teacher/courses', icon: 'video_library', labelKey: 'nav.centerCourses' },
  { to: '/center/subjects', icon: 'menu_book', labelKey: 'nav.centerSubjects' },
  { to: '/teacher/groups', icon: 'diversity_3', labelKey: 'nav.groups' },
  { to: '/teacher/schedule', icon: 'calendar_month', labelKey: 'nav.schedule' },
  { to: '/teacher/analytics', icon: 'monitoring', labelKey: 'nav.analytics' },
  { to: '/teacher/wallet', icon: 'account_balance_wallet', labelKey: 'nav.wallet' },
  { to: '/center/activity', icon: 'history', labelKey: 'nav.centerActivity' },
  { to: '/center/studio', icon: 'palette', labelKey: 'nav.centerStudio' },
  { to: '/center/settings', icon: 'settings', labelKey: 'nav.centerSettings' },
];

/**
 * An assistant's navigation is drawn from what they may do — an entry for a
 * capability they do not hold would only lead to a refusal. The server still
 * refuses regardless; this only keeps the menu honest.
 */
export function assistantNav(permissions: string[]): NavItem[] {
  const has = (c: string) => permissions.includes(c);
  return [
    { to: '/staff', icon: 'groups', labelKey: 'nav.staffHome', end: true },
    ...(has('message.reply') ? [{ to: '/messages', icon: 'forum', labelKey: 'nav.messages' }] : []),
    ...(has('assessment.grade')
      ? [{ to: '/staff/grading', icon: 'grading', labelKey: 'nav.grading' }]
      : []),
    ...(has('group.manage') || has('attendance.mark')
      ? [{ to: '/teacher/groups', icon: 'diversity_3', labelKey: 'nav.groups' }]
      : []),
    ...(has('schedule.manage')
      ? [{ to: '/teacher/schedule', icon: 'calendar_month', labelKey: 'nav.schedule' }]
      : []),
    ...(has('payment.view')
      ? [{ to: '/staff/payments', icon: 'receipt_long', labelKey: 'nav.staffPayments' }]
      : []),
  ];
}

/**
 * The student register (Center Operations C1). Not in any static list: the
 * layout adds it only where the academy has the register switched on and the
 * viewer may read it (GET /center-students/access) — a menu entry that led to
 * "not available here" would only teach people to ignore the menu.
 */
export const REGISTRY_ITEM: NavItem = {
  to: '/center/students',
  icon: 'badge',
  labelKey: 'nav.centerStudents',
};

/**
 * Today's classes (Center Operations C2). Like the register, added by the
 * layout only where classes are switched on and the viewer may take
 * attendance (GET /class-ops/access).
 */
/** The reception desk (C3): scan, find, check in. Shown where it is on and allowed. */
export const DESK_ITEM: NavItem = {
  to: '/desk',
  icon: 'qr_code_scanner',
  labelKey: 'nav.desk',
};

/** The center's own fees (C4): who owes, the day's collections, plans. */
export const FEES_ITEM: NavItem = {
  to: '/center/fees',
  icon: 'payments',
  labelKey: 'nav.centerFees',
};

export const FOLLOW_UP_ITEM: NavItem = {
  to: '/center/follow-up',
  icon: 'support_agent',
  labelKey: 'nav.followUp',
};

export const CLASSES_ITEM: NavItem = {
  to: '/classes',
  icon: 'co_present',
  labelKey: 'nav.classes',
};

/** A teacher who also assists in someone else's academy gets one door to that workspace. */
export const ASSISTING_ITEM: NavItem = {
  to: '/staff',
  icon: 'support_agent',
  labelKey: 'nav.assisting',
};

/** A guardian: their children, and the conversations about them. Nothing else. */
export const GUARDIAN_NAV: NavItem[] = [
  { to: '/guardian', icon: 'family_restroom', labelKey: 'nav.guardianHome', end: true },
  { to: '/messages', icon: 'forum', labelKey: 'nav.messages' },
];

export const ADMIN_NAV: NavItem[] = [
  {
    to: '/admin',
    icon: 'space_dashboard',
    labelKey: 'nav.adminOverview',
    shortLabelKey: 'nav.short.adminOverview',
    end: true,
  },
  { to: '/admin/academies', icon: 'apartment', labelKey: 'nav.adminAcademies' },
  {
    to: '/admin/teachers',
    icon: 'verified_user',
    labelKey: 'nav.adminTeachers',
    shortLabelKey: 'nav.short.adminTeachers',
  },
  { to: '/admin/academy-studio', icon: 'auto_awesome', labelKey: 'nav.adminStudio' },
  { to: '/admin/studio', icon: 'tune', labelKey: 'nav.adminControlStudio' },
  { to: '/admin/payments', icon: 'receipt_long', labelKey: 'nav.adminPayments' },
  { to: '/admin/live-commerce', icon: 'sensors', labelKey: 'nav.adminLiveCommerce' },
  {
    to: '/admin/wallet',
    icon: 'account_balance_wallet',
    labelKey: 'nav.adminWallet',
    shortLabelKey: 'nav.short.adminWallet',
  },
  { to: '/admin/payouts', icon: 'payments', labelKey: 'nav.adminPayouts' },
  { to: '/admin/gamification', icon: 'trophy', labelKey: 'nav.adminGamification' },
  { to: '/admin/devices', icon: 'smartphone', labelKey: 'nav.adminDevices' },
  { to: '/admin/security', icon: 'gpp_maybe', labelKey: 'nav.adminSecurity' },
];

/**
 * The destinations that earn a permanent spot on a phone, per role —
 * everything else stays one tap away behind "more". In order of priority:
 * the layout keeps the first MAX_BOTTOM_TABS that this person actually has
 * (an entry that is switched off here simply drops out).
 */
export const MAX_BOTTOM_TABS = 5;

export const BOTTOM_TABS: Record<string, string[]> = {
  [Role.STUDENT]: ['/', '/my-courses', '/learning', '/messages', '/wallet'],
  [Role.TEACHER]: [
    '/teacher',
    '/classes',
    '/teacher/courses',
    '/teacher/students',
    '/messages',
    '/teacher/wallet',
  ],
  [Role.SUPER_ADMIN]: ['/admin', '/admin/teachers', '/admin/payments', '/admin/wallet'],
  [Role.STAFF]: [
    '/center',
    '/desk',
    '/classes',
    '/center/students',
    '/center/members',
    '/teacher/groups',
    '/teacher/schedule',
  ],
  ASSISTANT: [
    '/staff',
    '/desk',
    '/classes',
    '/center/students',
    '/messages',
    '/staff/grading',
    '/staff/payments',
  ],
  [Role.GUARDIAN]: ['/guardian', '/messages'],
};

export function navFor(role: string | undefined): NavItem[] {
  if (role === Role.SUPER_ADMIN) return ADMIN_NAV;
  if (role === Role.TEACHER) return TEACHER_NAV;
  if (role === Role.STAFF) return STAFF_NAV;
  if (role === Role.GUARDIAN) return GUARDIAN_NAV;
  return STUDENT_NAV;
}
