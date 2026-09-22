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
  { to: '/teacher/courses', icon: 'video_library', labelKey: 'nav.courseBuilder' },
  { to: '/teacher/challenges', icon: 'social_leaderboard', labelKey: 'nav.challenges' },
  { to: '/teacher/students', icon: 'groups', labelKey: 'nav.myStudents' },
  { to: '/teacher/groups', icon: 'diversity_3', labelKey: 'nav.groups' },
  { to: '/teacher/schedule', icon: 'calendar_month', labelKey: 'nav.schedule' },
  { to: '/teacher/grading', icon: 'grading', labelKey: 'nav.grading' },
  { to: '/teacher/analytics', icon: 'monitoring', labelKey: 'nav.analytics' },
  { to: '/teacher/live', icon: 'sensors', labelKey: 'nav.live' },
  { to: '/messages', icon: 'forum', labelKey: 'nav.messages' },
  { to: '/teacher/wallet', icon: 'account_balance_wallet', labelKey: 'nav.wallet' },
  { to: '/teacher/security', icon: 'shield', labelKey: 'nav.security' },
  { to: '/teacher/coupons', icon: 'sell', labelKey: 'nav.coupons' },
];

export const STAFF_NAV: NavItem[] = [
  { to: '/center', icon: 'apartment', labelKey: 'nav.centerDashboard', end: true },
  { to: '/center/members', icon: 'group', labelKey: 'nav.centerMembers' },
  { to: '/teacher/courses', icon: 'video_library', labelKey: 'nav.courseBuilder' },
  { to: '/center/subjects', icon: 'menu_book', labelKey: 'nav.centerSubjects' },
  { to: '/teacher/groups', icon: 'diversity_3', labelKey: 'nav.groups' },
  { to: '/teacher/schedule', icon: 'calendar_month', labelKey: 'nav.schedule' },
  { to: '/teacher/analytics', icon: 'monitoring', labelKey: 'nav.analytics' },
  { to: '/center/activity', icon: 'history', labelKey: 'nav.centerActivity' },
  { to: '/center/settings', icon: 'settings', labelKey: 'nav.centerSettings' },
];

export const ADMIN_NAV: NavItem[] = [
  { to: '/admin', icon: 'space_dashboard', labelKey: 'nav.adminOverview', end: true },
  { to: '/admin/academies', icon: 'apartment', labelKey: 'nav.adminAcademies' },
  { to: '/admin/teachers', icon: 'verified_user', labelKey: 'nav.adminTeachers' },
  { to: '/admin/academy-studio', icon: 'auto_awesome', labelKey: 'nav.adminStudio' },
  { to: '/admin/studio', icon: 'tune', labelKey: 'nav.adminControlStudio' },
  { to: '/admin/payments', icon: 'receipt_long', labelKey: 'nav.adminPayments' },
  { to: '/admin/wallet', icon: 'account_balance_wallet', labelKey: 'nav.adminWallet' },
  { to: '/admin/payouts', icon: 'payments', labelKey: 'nav.adminPayouts' },
  { to: '/admin/gamification', icon: 'trophy', labelKey: 'nav.adminGamification' },
  { to: '/admin/devices', icon: 'smartphone', labelKey: 'nav.adminDevices' },
  { to: '/admin/security', icon: 'gpp_maybe', labelKey: 'nav.adminSecurity' },
];

/**
 * The destinations that earn a permanent spot on a phone, per role —
 * everything else stays one tap away behind "more".
 */
export const BOTTOM_TABS: Record<string, string[]> = {
  [Role.STUDENT]: ['/', '/my-courses', '/learning', '/messages', '/wallet'],
  [Role.TEACHER]: ['/teacher', '/teacher/courses', '/teacher/students', '/messages', '/teacher/wallet'],
  [Role.SUPER_ADMIN]: ['/admin', '/admin/teachers', '/admin/payments', '/admin/wallet'],
  [Role.STAFF]: ['/center', '/center/members', '/teacher/groups', '/teacher/schedule'],
};

export function navFor(role: string | undefined): NavItem[] {
  if (role === Role.SUPER_ADMIN) return ADMIN_NAV;
  if (role === Role.TEACHER) return TEACHER_NAV;
  if (role === Role.STAFF) return STAFF_NAV;
  return STUDENT_NAV;
}
