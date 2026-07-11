import { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Role } from '@darsly/shared-types';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import MessagesPage from './pages/MessagesPage';
import CertificateViewPage from './pages/CertificateViewPage';
import AdminOverviewPage from './pages/admin/AdminOverviewPage';
import AdminPayoutsPage from './pages/admin/AdminPayoutsPage';
import AdminSecurityPage from './pages/admin/AdminSecurityPage';
import AdminTeachersPage from './pages/admin/AdminTeachersPage';
import CourseDetailPage from './pages/student/CourseDetailPage';
import DiscoveryPage from './pages/student/DiscoveryPage';
import MyCoursesPage from './pages/student/MyCoursesPage';
import CertificatesPage from './pages/student/CertificatesPage';
import LessonRouter from './pages/student/LessonRouter';
import StudentDashboardPage from './pages/student/StudentDashboardPage';
import TeacherProfilePage from './pages/student/TeacherProfilePage';
import AssignmentBuilderPage from './pages/teacher/AssignmentBuilderPage';
import CourseBuilderPage from './pages/teacher/CourseBuilderPage';
import QuizBuilderPage from './pages/teacher/QuizBuilderPage';
import TeacherCoursesPage from './pages/teacher/TeacherCoursesPage';
import TeacherCouponsPage from './pages/teacher/TeacherCouponsPage';
import TeacherDashboardPage from './pages/teacher/TeacherDashboardPage';
import TeacherEnrollmentsPage from './pages/teacher/TeacherEnrollmentsPage';
import TeacherSecurityPage from './pages/teacher/TeacherSecurityPage';
import TeacherWalletPage from './pages/teacher/TeacherWalletPage';
import { useAuthStore } from './stores/auth';

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
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      {/* Student / public browsing */}
      <Route path="/" element={<HomeRedirect />} />
      <Route path="/discover" element={<RequireAuth><DiscoveryPage /></RequireAuth>} />
      <Route path="/t/:slug" element={<RequireAuth><TeacherProfilePage /></RequireAuth>} />
      <Route path="/course/:id" element={<RequireAuth><CourseDetailPage /></RequireAuth>} />
      <Route path="/learn/:courseId/:lessonId" element={<RequireAuth><LessonRouter /></RequireAuth>} />
      <Route path="/my-courses" element={<RequireAuth role={Role.STUDENT}><MyCoursesPage /></RequireAuth>} />
      <Route path="/my-certificates" element={<RequireAuth role={Role.STUDENT}><CertificatesPage /></RequireAuth>} />
      <Route path="/certificate/:serial" element={<RequireAuth><CertificateViewPage /></RequireAuth>} />
      <Route path="/messages" element={<RequireAuth><MessagesPage /></RequireAuth>} />

      {/* Teacher studio */}
      <Route path="/teacher" element={<RequireAuth role={Role.TEACHER}><TeacherDashboardPage /></RequireAuth>} />
      <Route path="/teacher/courses" element={<RequireAuth role={Role.TEACHER}><TeacherCoursesPage /></RequireAuth>} />
      <Route path="/teacher/courses/:id" element={<RequireAuth role={Role.TEACHER}><CourseBuilderPage /></RequireAuth>} />
      <Route path="/teacher/lessons/:lessonId/quiz" element={<RequireAuth role={Role.TEACHER}><QuizBuilderPage /></RequireAuth>} />
      <Route path="/teacher/lessons/:lessonId/assignment" element={<RequireAuth role={Role.TEACHER}><AssignmentBuilderPage /></RequireAuth>} />
      <Route path="/teacher/students" element={<RequireAuth role={Role.TEACHER}><TeacherEnrollmentsPage /></RequireAuth>} />
      <Route path="/teacher/wallet" element={<RequireAuth role={Role.TEACHER}><TeacherWalletPage /></RequireAuth>} />
      <Route path="/teacher/security" element={<RequireAuth role={Role.TEACHER}><TeacherSecurityPage /></RequireAuth>} />
      <Route path="/teacher/coupons" element={<RequireAuth role={Role.TEACHER}><TeacherCouponsPage /></RequireAuth>} />

      {/* Admin */}
      <Route path="/admin" element={<RequireAuth role={Role.SUPER_ADMIN}><AdminOverviewPage /></RequireAuth>} />
      <Route path="/admin/teachers" element={<RequireAuth role={Role.SUPER_ADMIN}><AdminTeachersPage /></RequireAuth>} />
      <Route path="/admin/payouts" element={<RequireAuth role={Role.SUPER_ADMIN}><AdminPayoutsPage /></RequireAuth>} />
      <Route path="/admin/security" element={<RequireAuth role={Role.SUPER_ADMIN}><AdminSecurityPage /></RequireAuth>} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
