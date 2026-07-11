import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { Spinner } from '../../components/ui';
import SecureVideoPlayerPage from './SecureVideoPlayerPage';
import QuizTakerPage from './QuizTakerPage';
import AssignmentPage from './AssignmentPage';

/**
 * Dispatches a lesson to the right experience by its type. Video lessons keep
 * the hardened player untouched; quiz/assignment lessons render their own view.
 * The course query is shared (react-query cache) with the child pages.
 */
export default function LessonRouter() {
  const { courseId, lessonId } = useParams();
  const { data: course, isLoading } = useQuery({
    queryKey: ['course', courseId],
    queryFn: async () => (await api.get(`/courses/${courseId}`)).data,
  });

  if (isLoading) return <div className="grid place-items-center py-24"><Spinner /></div>;
  const lesson = course?.units.flatMap((u: any) => u.lessons).find((l: any) => l.id === lessonId);

  if (lesson?.type === 'QUIZ') return <QuizTakerPage />;
  if (lesson?.type === 'ASSIGNMENT') return <AssignmentPage />;
  return <SecureVideoPlayerPage />;
}
