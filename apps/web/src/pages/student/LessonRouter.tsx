import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { Spinner } from '../../components/ui';

// Lazy per type so the heavy video player (hls.js, ~half the bundle) loads
// ONLY when a student opens a video lesson — quizzes/assignments stay light.
const SecureVideoPlayerPage = lazy(() => import('./SecureVideoPlayerPage'));
const QuizTakerPage = lazy(() => import('./QuizTakerPage'));
const AssignmentPage = lazy(() => import('./AssignmentPage'));

/**
 * Dispatches a lesson to the right experience by its type. The course query is
 * shared (react-query cache) with the child pages.
 */
export default function LessonRouter() {
  const { courseId, lessonId } = useParams();
  const { data: course, isLoading } = useQuery({
    queryKey: ['course', courseId],
    queryFn: async () => (await api.get(`/courses/${courseId}`)).data,
  });

  if (isLoading) return <div className="grid place-items-center py-24"><Spinner /></div>;
  const lesson = course?.units.flatMap((u: any) => u.lessons).find((l: any) => l.id === lessonId);

  const Screen =
    lesson?.type === 'QUIZ' ? QuizTakerPage : lesson?.type === 'ASSIGNMENT' ? AssignmentPage : SecureVideoPlayerPage;

  return (
    <Suspense fallback={<div className="grid place-items-center py-24"><Spinner /></div>}>
      <Screen />
    </Suspense>
  );
}
