import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { ErrorNote, Spinner } from '../../components/ui';

interface ExamDocument {
  title: string;
  meta: string[];
  instructions: string[];
  timeLimitMin: number | null;
  totalMarks: number;
  sections: {
    title: string;
    questions: {
      number: number;
      text: string;
      options: string[];
      marks: number | null;
      writtenAnswer: boolean;
    }[];
  }[];
  rtl: boolean;
}

/**
 * An exam, laid out to be printed.
 *
 * The PDF export. Not a server-rendered PDF, and deliberately: this is Arabic
 * exam paper, and getting Arabic onto a page means shaping the letters and
 * resolving the bidirectional runs around every English term and every number
 * in it. The browser already does that perfectly, for free, on every device —
 * no small PDF library does it at all, and the one that does would mean
 * shipping a headless Chromium in the API image to drive it.
 *
 * So the structured exam is laid out here with `@media print` rules and the
 * teacher prints to PDF, which is the same route `CertificateViewPage` takes.
 * What is printed is built from the question set, never from the uploaded
 * photographs — a scan of the original is the thing the teacher already had.
 *
 * Works for any exam, not just an imported one.
 */
export default function ExamPrintPage() {
  const { t } = useTranslation();
  const { lessonId } = useParams();
  const [search] = useSearchParams();
  const courseId = search.get('course');

  const { data, isLoading, error } = useQuery<ExamDocument>({
    queryKey: ['exam-document', lessonId],
    queryFn: async () => (await api.get(`/teacher/lessons/${lessonId}/exam/document`)).data,
    enabled: !!lessonId,
  });

  if (isLoading)
    return (
      <div className="grid place-items-center py-20">
        <Spinner />
      </div>
    );
  if (error || !data)
    return (
      <div className="page">
        <ErrorNote error={error} />
      </div>
    );

  return (
    <div className="min-h-screen bg-surface-container px-4 py-10 print:min-h-0 print:bg-white print:p-0">
      {/* Everything the paper is not. Hidden the moment it is printed. */}
      <div className="mx-auto mb-4 flex max-w-[210mm] flex-wrap items-center justify-between gap-2 print:hidden">
        <Link
          to={
            courseId
              ? `/teacher/courses/${courseId}?lesson=${lessonId}`
              : `/teacher/lessons/${lessonId}/quiz`
          }
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          <span className="material-symbols-outlined text-base rtl:-scale-x-100">arrow_back</span>
          {t('paper.backToExam')}
        </Link>
        <div className="flex gap-2">
          <button className="btn-primary" onClick={() => window.print()}>
            <span className="material-symbols-outlined text-base">print</span>
            {t('paper.printPdf')}
          </button>
          <a
            className="btn-secondary"
            href={`${api.defaults.baseURL}/teacher/lessons/${lessonId}/exam/export.docx`}
            onClick={async (e) => {
              // The download needs the bearer token, which an <a> cannot send:
              // fetched through the client and handed to the browser as a blob.
              e.preventDefault();
              const { data: file } = await api.get(
                `/teacher/lessons/${lessonId}/exam/export.docx`,
                { responseType: 'blob' },
              );
              const url = URL.createObjectURL(file as Blob);
              const link = document.createElement('a');
              link.href = url;
              link.download = `${data.title || 'exam'}.docx`;
              link.click();
              URL.revokeObjectURL(url);
            }}
          >
            <span className="material-symbols-outlined text-base">description</span>
            {t('paper.downloadDocx')}
          </a>
        </div>
      </div>

      {/* The paper. A4 on screen so what is seen is what is printed. */}
      <article
        dir={data.rtl ? 'rtl' : 'ltr'}
        className="exam-sheet mx-auto w-full max-w-[210mm] bg-white p-[20mm] text-black shadow-elevated print:max-w-none print:p-0 print:shadow-none"
      >
        <header className="mb-6 border-b-2 border-black pb-4 text-center">
          <h1 className="font-heading text-2xl font-extrabold">{data.title}</h1>
          {data.meta.length > 0 && <p className="mt-1 text-sm">{data.meta.join(' · ')}</p>}
          {/* The teacher's own words, then the two facts every paper prints
              — composed here, where the language is known. */}
          <ul className="mt-3 text-start text-sm">
            {data.instructions.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
            {data.timeLimitMin != null && <li>{t('paper.timeLimit', { n: data.timeLimitMin })}</li>}
            <li>{t('paper.totalMarks', { n: data.totalMarks })}</li>
          </ul>
        </header>

        {data.sections.map((section, si) => (
          <section key={si} className="mb-6">
            {section.title && (
              <h2 className="mb-3 font-heading text-lg font-bold">{section.title}</h2>
            )}
            {section.questions.map((q) => (
              // `break-inside-avoid` keeps a question and its options on one
              // page: a stem at the bottom of page 1 with its answers on page 2
              // is the classic way a printed exam becomes unusable.
              <div key={q.number} className="mb-5 break-inside-avoid">
                <p className="font-semibold leading-relaxed">
                  <span className="me-2">{q.number}.</span>
                  {q.text}
                  {q.marks != null && <span className="ms-2 font-normal">[{q.marks}]</span>}
                </p>
                {q.options.length > 0 && (
                  <ol className="mt-2 space-y-1 ps-8">
                    {q.options.map((option, oi) => (
                      <li key={oi} className="leading-relaxed">
                        {option}
                      </li>
                    ))}
                  </ol>
                )}
                {q.writtenAnswer && (
                  <div className="mt-3 space-y-5 ps-8">
                    <div className="border-b border-dotted border-black/50" />
                    <div className="border-b border-dotted border-black/50" />
                    <div className="border-b border-dotted border-black/50" />
                  </div>
                )}
              </div>
            ))}
          </section>
        ))}

        <footer className="mt-8 border-t border-black/30 pt-3 text-center text-xs">
          {/* The total is already in the rubric at the top; the foot of an
              exam paper says it has ended. */}
          {t('paper.endOfPaper')}
        </footer>
      </article>
    </div>
  );
}
