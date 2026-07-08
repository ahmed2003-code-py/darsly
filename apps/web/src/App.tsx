import { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Role } from '@darsly/shared-types';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import CourseDetailPage from './pages/student/CourseDetailPage';
import DiscoveryPage from './pages/student/DiscoveryPage';
import MyCoursesPage from './pages/student/MyCoursesPage';
import TeacherProfilePage from './pages/student/TeacherProfilePage';
import CourseBuilderPage from './pages/teacher/CourseBuilderPage';
import TeacherCoursesPage from './pages/teacher/TeacherCoursesPage';
import TeacherCouponsPage from './pages/teacher/TeacherCouponsPage';
import TeacherDashboardPage from './pages/teacher/TeacherDashboardPage';
import TeacherEnrollmentsPage from './pages/teacher/TeacherEnrollmentsPage';
import { useAuthStore } from './stores/auth';

function RequireAuth({ children, role }: { children: ReactNode; role?: Role }) {
  const { accessToken, user } = useAuthStore();
  if (!accessToken) return <Navigate to="/login" replace />;
  if (role && user?.role !== role && user?.role !== Role.SUPER_ADMIN) {
    return <Navigate to={user?.role === Role.TEACHER ? '/teacher' : '/'} replace />;
  }
  return <Layout>{children}</Layout>;
}

/** Teachers land on their dashboard; students (and admin, until Phase 5) on discovery. */
function HomeRedirect() {
  const user = useAuthStore((s) => s.user);
  if (user?.role === Role.TEACHER) return <Navigate to="/teacher" replace />;
  return (
    <RequireAuth>
      <DiscoveryPage />
    </RequireAuth>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      {/* Student / public browsing */}
      <Route path="/" element={<HomeRedirect />} />
      <Route path="/t/:slug" element={<RequireAuth><TeacherProfilePage /></RequireAuth>} />
      <Route path="/course/:id" element={<RequireAuth><CourseDetailPage /></RequireAuth>} />
      <Route path="/my-courses" element={<RequireAuth role={Role.STUDENT}><MyCoursesPage /></RequireAuth>} />

      {/* Teacher studio */}
      <Route path="/teacher" element={<RequireAuth role={Role.TEACHER}><TeacherDashboardPage /></RequireAuth>} />
      <Route path="/teacher/courses" element={<RequireAuth role={Role.TEACHER}><TeacherCoursesPage /></RequireAuth>} />
      <Route path="/teacher/courses/:id" element={<RequireAuth role={Role.TEACHER}><CourseBuilderPage /></RequireAuth>} />
      <Route path="/teacher/students" element={<RequireAuth role={Role.TEACHER}><TeacherEnrollmentsPage /></RequireAuth>} />
      <Route path="/teacher/coupons" element={<RequireAuth role={Role.TEACHER}><TeacherCouponsPage /></RequireAuth>} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
