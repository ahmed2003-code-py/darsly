import { lazy, ReactNode, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Role } from '@darsly/shared-types';
import Layout from './components/Layout';
import { Spinner } from './components/ui';
import LoginPage from './pages/LoginPage';
import { useAuthStore } from './stores/auth';

// Route-level code splitting: each screen is its own chunk, so the initial
// load only ships the shell + login. Keeps the app fast as it scales.
const RegisterPage = lazy(() => import('./pages/RegisterPage'));
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage'));
const MessagesPage = lazy(() => import('./pages/MessagesPage'));
const CertificateViewPage = lazy(() => import('./pages/CertificateViewPage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const AdminOverviewPage = lazy(() => import('./pages/admin/AdminOverviewPage'));
const AdminPayoutsPage = lazy(() => import('./pages/admin/AdminPayoutsPage'));
const AdminSecurityPage = lazy(() => import('./pages/admin/AdminSecurityPage'));
const AdminTeachersPage = lazy(() => import('./pages/admin/AdminTeachersPage'));
const CourseDetailPage = lazy(() => import('./pages/student/CourseDetailPage'));
const DiscoveryPage = lazy(() => import('./pages/student/DiscoveryPage'));
const MyCoursesPage = lazy(() => import('./pages/student/MyCoursesPage'));
const CertificatesPage = lazy(() => import('./pages/student/CertificatesPage'));
const LiveSessionsPage = lazy(() => import('./pages/student/LiveSessionsPage'));
const SavedCoursesPage = lazy(() => import('./pages/student/SavedCoursesPage'));
const LessonRouter = lazy(() => import('./pages/student/LessonRouter'));
const StudentDashboardPage = lazy(() => import('./pages/student/StudentDashboardPage'));
const TeacherProfilePage = lazy(() => import('./pages/student/TeacherProfilePage'));
const AssignmentBuilderPage = lazy(() => import('./pages/teacher/AssignmentBuilderPage'));
const CourseBuilderPage = lazy(() => import('./pages/teacher/CourseBuilderPage'));
const TeacherLivePage = lazy(() => import('./pages/teacher/TeacherLivePage'));
const TeacherPaymentsPage = lazy(() => import('./pages/teacher/TeacherPaymentsPage'));
const AdminPaymentsPage = lazy(() => import('./pages/admin/AdminPaymentsPage'));
const TeacherAnalyticsPage = lazy(() => import('./pages/teacher/TeacherAnalyticsPage'));
const QuizBuilderPage = lazy(() => import('./pages/teacher/QuizBuilderPage'));
const TeacherCoursesPage = lazy(() => import('./pages/teacher/TeacherCoursesPage'));
const TeacherCouponsPage = lazy(() => import('./pages/teacher/TeacherCouponsPage'));
const TeacherDashboardPage = lazy(() => import('./pages/teacher/TeacherDashboardPage'));
const TeacherEnrollmentsPage = lazy(() => import('./pages/teacher/TeacherEnrollmentsPage'));
const TeacherSecurityPage = lazy(() => import('./pages/teacher/TeacherSecurityPage'));
const TeacherWalletPage = lazy(() => import('./pages/teacher/TeacherWalletPage'));

function RequireAuth({ children, role }: { children: ReactNode; role?: Role }) {
  const { accessToken, user } = useAuthStore();
  if (!accessToken) return <Navigate to="/login" replace />;
  if (role && user?.role !== role && user?.role !== Role.SUPER_ADMIN) {
    return <Navigate to={user?.role === Role.TEACHER ? '/teacher' : '/'} replace />;
  }
  return <Layout>{children}</Layout>;
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

export default function App() {
  return (
    <Suspense fallback={<div className="grid min-h-screen place-items-center"><Spinner /></div>}>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />

      {/* Student / public browsing */}
      <Route path="/" element={<HomeRedirect />} />
      <Route path="/discover" element={<RequireAuth><DiscoveryPage /></RequireAuth>} />
      <Route path="/t/:slug" element={<RequireAuth><TeacherProfilePage /></RequireAuth>} />
      <Route path="/course/:id" element={<RequireAuth><CourseDetailPage /></RequireAuth>} />
      <Route path="/learn/:courseId/:lessonId" element={<RequireAuth><LessonRouter /></RequireAuth>} />
      <Route path="/my-courses" element={<RequireAuth role={Role.STUDENT}><MyCoursesPage /></RequireAuth>} />
      <Route path="/my-certificates" element={<RequireAuth role={Role.STUDENT}><CertificatesPage /></RequireAuth>} />
      <Route path="/live" element={<RequireAuth role={Role.STUDENT}><LiveSessionsPage /></RequireAuth>} />
      <Route path="/saved" element={<RequireAuth role={Role.STUDENT}><SavedCoursesPage /></RequireAuth>} />
      <Route path="/certificate/:serial" element={<RequireAuth><CertificateViewPage /></RequireAuth>} />
      <Route path="/messages" element={<RequireAuth><MessagesPage /></RequireAuth>} />
      <Route path="/profile" element={<RequireAuth><ProfilePage /></RequireAuth>} />

      {/* Teacher studio */}
      <Route path="/teacher" element={<RequireAuth role={Role.TEACHER}><TeacherDashboardPage /></RequireAuth>} />
      <Route path="/teacher/courses" element={<RequireAuth role={Role.TEACHER}><TeacherCoursesPage /></RequireAuth>} />
      <Route path="/teacher/courses/:id" element={<RequireAuth role={Role.TEACHER}><CourseBuilderPage /></RequireAuth>} />
      <Route path="/teacher/lessons/:lessonId/quiz" element={<RequireAuth role={Role.TEACHER}><QuizBuilderPage /></RequireAuth>} />
      <Route path="/teacher/lessons/:lessonId/assignment" element={<RequireAuth role={Role.TEACHER}><AssignmentBuilderPage /></RequireAuth>} />
      <Route path="/teacher/students" element={<RequireAuth role={Role.TEACHER}><TeacherEnrollmentsPage /></RequireAuth>} />
      <Route path="/teacher/payments" element={<RequireAuth role={Role.TEACHER}><TeacherPaymentsPage /></RequireAuth>} />
      <Route path="/teacher/live" element={<RequireAuth role={Role.TEACHER}><TeacherLivePage /></RequireAuth>} />
      <Route path="/teacher/analytics" element={<RequireAuth role={Role.TEACHER}><TeacherAnalyticsPage /></RequireAuth>} />
      <Route path="/teacher/wallet" element={<RequireAuth role={Role.TEACHER}><TeacherWalletPage /></RequireAuth>} />
      <Route path="/teacher/security" element={<RequireAuth role={Role.TEACHER}><TeacherSecurityPage /></RequireAuth>} />
      <Route path="/teacher/coupons" element={<RequireAuth role={Role.TEACHER}><TeacherCouponsPage /></RequireAuth>} />

      {/* Admin */}
      <Route path="/admin" element={<RequireAuth role={Role.SUPER_ADMIN}><AdminOverviewPage /></RequireAuth>} />
      <Route path="/admin/teachers" element={<RequireAuth role={Role.SUPER_ADMIN}><AdminTeachersPage /></RequireAuth>} />
      <Route path="/admin/payouts" element={<RequireAuth role={Role.SUPER_ADMIN}><AdminPayoutsPage /></RequireAuth>} />
      <Route path="/admin/payments" element={<RequireAuth role={Role.SUPER_ADMIN}><AdminPaymentsPage /></RequireAuth>} />
      <Route path="/admin/security" element={<RequireAuth role={Role.SUPER_ADMIN}><AdminSecurityPage /></RequireAuth>} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  );
}
