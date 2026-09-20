import { ReactNode, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Role } from '@darsly/shared-types';
import BrandTheme from './components/BrandTheme';
import ErrorBoundary from './components/ErrorBoundary';
import Layout from './components/Layout';
import { Spinner } from './components/ui';
import { setStudioSuspended } from './lib/studio';
import LoginPage from './pages/LoginPage';
import { lazyPage } from './lib/lazyPage';
import { loginUrlFor } from './lib/redirect';
import { useAuthStore } from './stores/auth';

// Route-level code splitting: each screen is its own chunk, so the initial
// load only ships the shell + login. Keeps the app fast as it scales.
// `lazyPage` rather than `lazy`: fetching a chunk is a network request, and one
// that fails on a waking phone must not become an error screen.
const RegisterPage = lazyPage(() => import('./pages/RegisterPage'));
const ForgotPasswordPage = lazyPage(() => import('./pages/ForgotPasswordPage'));
const ResetPasswordPage = lazyPage(() => import('./pages/ResetPasswordPage'));
const AcademyStorefrontPage = lazyPage(() => import('./pages/academy/AcademyStorefrontPage'));
const MessagesPage = lazyPage(() => import('./pages/MessagesPage'));
const CertificateViewPage = lazyPage(() => import('./pages/CertificateViewPage'));
const ProfilePage = lazyPage(() => import('./pages/ProfilePage'));
const AdminOverviewPage = lazyPage(() => import('./pages/admin/AdminOverviewPage'));
const AdminAcademiesPage = lazyPage(() => import('./pages/admin/AdminAcademiesPage'));
const AdminAcademyDetailPage = lazyPage(() => import('./pages/admin/AdminAcademyDetailPage'));
const AdminPayoutsPage = lazyPage(() => import('./pages/admin/AdminPayoutsPage'));
const AdminSecurityPage = lazyPage(() => import('./pages/admin/AdminSecurityPage'));
const AdminTeachersPage = lazyPage(() => import('./pages/admin/AdminTeachersPage'));
const CourseDetailPage = lazyPage(() => import('./pages/student/CourseDetailPage'));
const DiscoveryPage = lazyPage(() => import('./pages/student/DiscoveryPage'));
const BrowseCoursesPage = lazyPage(() => import('./pages/student/BrowseCoursesPage'));
const MyCoursesPage = lazyPage(() => import('./pages/student/MyCoursesPage'));
const CertificatesPage = lazyPage(() => import('./pages/student/CertificatesPage'));
const LiveSessionsPage = lazyPage(() => import('./pages/student/LiveSessionsPage'));
const SavedCoursesPage = lazyPage(() => import('./pages/student/SavedCoursesPage'));
const LessonRouter = lazyPage(() => import('./pages/student/LessonRouter'));
const WalletPage = lazyPage(() => import('./pages/student/WalletPage'));
const LearningCenterPage = lazyPage(() => import('./pages/student/LearningCenterPage'));
const StudioPage = lazyPage(() => import('./pages/student/StudioPage'));
const ThemePreviewPage = lazyPage(() => import('./pages/student/ThemePreviewPage'));
const AdminWalletPage = lazyPage(() => import('./pages/admin/AdminWalletPage'));
const AdminDevicesPage = lazyPage(() => import('./pages/admin/AdminDevicesPage'));
const AdminGamificationPage = lazyPage(() => import('./pages/admin/AdminGamificationPage'));
const StudentDashboardPage = lazyPage(() => import('./pages/student/StudentDashboardPage'));
const TeacherProfilePage = lazyPage(() => import('./pages/student/TeacherProfilePage'));
const AssignmentBuilderPage = lazyPage(() => import('./pages/teacher/AssignmentBuilderPage'));
const CourseBuilderPage = lazyPage(() => import('./pages/teacher/CourseBuilderPage'));
const TeacherLivePage = lazyPage(() => import('./pages/teacher/TeacherLivePage'));
const MeetingPage = lazyPage(() => import('./pages/live/MeetingPage'));
const AdminPaymentsPage = lazyPage(() => import('./pages/admin/AdminPaymentsPage'));
const AdminAcademyStudioPage = lazyPage(() => import('./pages/admin/AdminAcademyStudioPage'));
const TeacherAnalyticsPage = lazyPage(() => import('./pages/teacher/TeacherAnalyticsPage'));
const QuizBuilderPage = lazyPage(() => import('./pages/teacher/QuizBuilderPage'));
const TeacherCoursesPage = lazyPage(() => import('./pages/teacher/TeacherCoursesPage'));
const ChallengesPage = lazyPage(() => import('./pages/student/ChallengesPage'));
const ChallengePlayPage = lazyPage(() => import('./pages/student/ChallengePlayPage'));
const TeacherChallengesPage = lazyPage(() => import('./pages/teacher/TeacherChallengesPage'));
const ChallengeBuilderPage = lazyPage(() => import('./pages/teacher/ChallengeBuilderPage'));
const GradingPage = lazyPage(() => import('./pages/teacher/GradingPage'));
const TeacherCouponsPage = lazyPage(() => import('./pages/teacher/TeacherCouponsPage'));
const TeacherDashboardPage = lazyPage(() => import('./pages/teacher/TeacherDashboardPage'));
const AcademyStudioPage = lazyPage(() => import('./pages/academy/AcademyStudioPage'));
const TeacherEnrollmentsPage = lazyPage(() => import('./pages/teacher/TeacherEnrollmentsPage'));
const TeacherGroupsPage = lazyPage(() => import('./pages/teacher/TeacherGroupsPage'));
const TeacherGroupDetailPage = lazyPage(() => import('./pages/teacher/TeacherGroupDetailPage'));
const TeacherSecurityPage = lazyPage(() => import('./pages/teacher/TeacherSecurityPage'));
const TeacherWalletPage = lazyPage(() => import('./pages/teacher/TeacherWalletPage'));

/**
 * `bare` drops the sidebar, top bar and bottom navigation.
 *
 * For the live classroom: a phone in a class has one job, and three rows of
 * app chrome is three rows the video does not get. Everything else about the
 * guard — the token, the role, the redirect that remembers where you were
 * going — is unchanged, because a page without navigation is still a page
 * that has to be signed in for.
 */
function RequireAuth({ children, role, bare }: { children: ReactNode; role?: Role; bare?: boolean }) {
  const { accessToken, user } = useAuthStore();
  const location = useLocation();
  // Carry the destination to the login page. A visitor arriving from a generated
  // academy site ("ابدأ الآن" → /course/<id>) would otherwise be dropped on a
  // dashboard after signing in, with no way back to the course they came for.
  if (!accessToken) {
    return <Navigate to={loginUrlFor(location.pathname, location.search)} replace />;
  }
  // A route built for one role is not opened for another, and that includes the
  // super admin. The blanket exemption that used to sit here meant an admin who
  // signed in behind a student landed on `/wallet` — a page that says "my
  // balance" and means the signed-in person's — and read it as if it were
  // theirs. An admin has their own console for every one of these (`/admin/…`);
  // being able to walk into the student's own pages was never the point.
  if (role && user?.role !== role) {
    return <Navigate to={homeFor(user?.role)} replace />;
  }
  if (bare) return <>{children}</>;
  return <Layout>{children}</Layout>;
}

/** Where a role belongs when it is somewhere it does not. */
function homeFor(role?: Role): string {
  if (role === Role.TEACHER) return '/teacher';
  if (role === Role.SUPER_ADMIN) return '/admin';
  return '/';
}

/** Each role lands on its own home. */
function HomeRedirect() {
  const user = useAuthStore((s) => s.user);
  if (user?.role === Role.TEACHER) return <Navigate to="/teacher" replace />;
  if (user?.role === Role.SUPER_ADMIN) return <Navigate to="/admin" replace />;
  return (
    <RequireAuth>
      <StudentDashboardPage />
    </RequireAuth>
  );
}

/**
 * Where the student's look reaches, and where it stops.
 *
 * It reaches everywhere the student goes — the nav, the logo, a teacher's
 * profile, the messages — because that is the whole point of buying it. It
 * stops at a published academy storefront: that page is the teacher's shopfront
 * and the first thing a stranger sees of them, and it is not somebody else's
 * to repaint. Held here rather than in the page so it is decided by the URL,
 * which is what the rule is actually about.
 */
function StudioReach() {
  const { pathname } = useLocation();
  useEffect(() => {
    const isStorefront = /^\/a\//.test(pathname);
    setStudioSuspended(isStorefront);
  }, [pathname]);
  return null;
}

export default function App() {
  return (
    <ErrorBoundary>
    {/* Above the router on purpose: the academy's colours belong to the whole
        app, not to one branch of it, and switching route must not repaint. */}
    <BrandTheme />
    {/* The one place a personal look does not go. */}
    <StudioReach />
    {/* The student's backdrop. One fixed element behind everything, drawn in
        CSS from a pattern name — so it costs nothing per route and there is no
        image to load. */}
    <div className="studio-backdrop" aria-hidden />
    <Suspense fallback={<div className="grid min-h-screen place-items-center"><Spinner /></div>}>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      {/* Public academy storefront (academy-branded, standalone shell) */}
      <Route path="/a/:slug" element={<AcademyStorefrontPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />

      {/* Student / public browsing */}
      <Route path="/" element={<HomeRedirect />} />
      <Route path="/discover" element={<RequireAuth><DiscoveryPage /></RequireAuth>} />
      <Route path="/courses" element={<RequireAuth><BrowseCoursesPage /></RequireAuth>} />
      <Route path="/t/:slug" element={<RequireAuth><TeacherProfilePage /></RequireAuth>} />
      <Route path="/course/:id" element={<RequireAuth><CourseDetailPage /></RequireAuth>} />
      <Route path="/learn/:courseId/:lessonId" element={<RequireAuth><LessonRouter /></RequireAuth>} />
      <Route path="/my-courses" element={<RequireAuth role={Role.STUDENT}><MyCoursesPage /></RequireAuth>} />
      <Route path="/my-certificates" element={<RequireAuth role={Role.STUDENT}><CertificatesPage /></RequireAuth>} />
      <Route path="/live" element={<RequireAuth role={Role.STUDENT}><LiveSessionsPage /></RequireAuth>} />
      {/* The classroom itself. No role here on purpose — the same page serves
          the teacher and the student, and which of them you are is decided by
          the API, not by the route you reached it through. */}
      <Route path="/live/:id/meeting" element={<RequireAuth bare><MeetingPage /></RequireAuth>} />
      <Route path="/saved" element={<RequireAuth role={Role.STUDENT}><SavedCoursesPage /></RequireAuth>} />
      <Route path="/wallet" element={<RequireAuth role={Role.STUDENT}><WalletPage /></RequireAuth>} />
      <Route path="/learning" element={<RequireAuth role={Role.STUDENT}><LearningCenterPage /></RequireAuth>} />
      <Route path="/challenges" element={<RequireAuth role={Role.STUDENT}><ChallengesPage /></RequireAuth>} />
      <Route path="/challenges/:id/play" element={<RequireAuth role={Role.STUDENT}><ChallengePlayPage /></RequireAuth>} />
      <Route path="/studio" element={<RequireAuth role={Role.STUDENT}><StudioPage /></RequireAuth>} />
      <Route path="/studio/preview/:key" element={<RequireAuth role={Role.STUDENT}><ThemePreviewPage /></RequireAuth>} />
      <Route path="/certificate/:token" element={<RequireAuth><CertificateViewPage /></RequireAuth>} />
      <Route path="/messages" element={<RequireAuth><MessagesPage /></RequireAuth>} />
      <Route path="/profile" element={<RequireAuth><ProfilePage /></RequireAuth>} />

      {/* Teacher studio */}
      <Route path="/teacher" element={<RequireAuth role={Role.TEACHER}><TeacherDashboardPage /></RequireAuth>} />
      <Route path="/academy/settings" element={<Navigate to="/academy/studio" replace />} />
      <Route path="/academy/studio" element={<RequireAuth role={Role.TEACHER}><AcademyStudioPage /></RequireAuth>} />
      <Route path="/teacher/courses" element={<RequireAuth role={Role.TEACHER}><TeacherCoursesPage /></RequireAuth>} />
      <Route path="/teacher/courses/:id" element={<RequireAuth role={Role.TEACHER}><CourseBuilderPage /></RequireAuth>} />
      <Route path="/teacher/lessons/:lessonId/quiz" element={<RequireAuth role={Role.TEACHER}><QuizBuilderPage /></RequireAuth>} />
      <Route path="/teacher/lessons/:lessonId/assignment" element={<RequireAuth role={Role.TEACHER}><AssignmentBuilderPage /></RequireAuth>} />
      <Route path="/teacher/challenges" element={<RequireAuth role={Role.TEACHER}><TeacherChallengesPage /></RequireAuth>} />
      <Route path="/teacher/challenges/:id" element={<RequireAuth role={Role.TEACHER}><ChallengeBuilderPage /></RequireAuth>} />
      <Route path="/teacher/students" element={<RequireAuth role={Role.TEACHER}><TeacherEnrollmentsPage /></RequireAuth>} />
      <Route path="/teacher/groups" element={<RequireAuth role={Role.TEACHER}><TeacherGroupsPage /></RequireAuth>} />
      <Route path="/teacher/groups/:groupId" element={<RequireAuth role={Role.TEACHER}><TeacherGroupDetailPage /></RequireAuth>} />
      <Route path="/teacher/grading" element={<RequireAuth role={Role.TEACHER}><GradingPage /></RequireAuth>} />
      <Route path="/teacher/live" element={<RequireAuth role={Role.TEACHER}><TeacherLivePage /></RequireAuth>} />
      <Route path="/teacher/analytics" element={<RequireAuth role={Role.TEACHER}><TeacherAnalyticsPage /></RequireAuth>} />
      <Route path="/teacher/wallet" element={<RequireAuth role={Role.TEACHER}><TeacherWalletPage /></RequireAuth>} />
      <Route path="/teacher/security" element={<RequireAuth role={Role.TEACHER}><TeacherSecurityPage /></RequireAuth>} />
      <Route path="/teacher/coupons" element={<RequireAuth role={Role.TEACHER}><TeacherCouponsPage /></RequireAuth>} />

      {/* Admin */}
      <Route path="/admin" element={<RequireAuth role={Role.SUPER_ADMIN}><AdminOverviewPage /></RequireAuth>} />
      <Route path="/admin/academies" element={<RequireAuth role={Role.SUPER_ADMIN}><AdminAcademiesPage /></RequireAuth>} />
      <Route path="/admin/academies/:id" element={<RequireAuth role={Role.SUPER_ADMIN}><AdminAcademyDetailPage /></RequireAuth>} />
      <Route path="/admin/teachers" element={<RequireAuth role={Role.SUPER_ADMIN}><AdminTeachersPage /></RequireAuth>} />
      <Route path="/admin/payouts" element={<RequireAuth role={Role.SUPER_ADMIN}><AdminPayoutsPage /></RequireAuth>} />
      <Route path="/admin/payments" element={<RequireAuth role={Role.SUPER_ADMIN}><AdminPaymentsPage /></RequireAuth>} />
      <Route path="/admin/wallet" element={<RequireAuth role={Role.SUPER_ADMIN}><AdminWalletPage /></RequireAuth>} />
      <Route path="/admin/devices" element={<RequireAuth role={Role.SUPER_ADMIN}><AdminDevicesPage /></RequireAuth>} />
      <Route path="/admin/gamification" element={<RequireAuth role={Role.SUPER_ADMIN}><AdminGamificationPage /></RequireAuth>} />
      <Route path="/admin/security" element={<RequireAuth role={Role.SUPER_ADMIN}><AdminSecurityPage /></RequireAuth>} />
      <Route path="/admin/academy-studio" element={<RequireAuth role={Role.SUPER_ADMIN}><AdminAcademyStudioPage /></RequireAuth>} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
    </ErrorBoundary>
  );
}
