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
  header?: {
    academy?: string | null;
    teacher?: string | null;
    course?: string | null;
    subject?: string | null;
    grade?: string | null;
    questionCount: number;
    passingScore?: number | null;
  };
}

/**
 * The printed words, in the paper's language — not the reader's. An Arabic
 * exam printed by a teacher whose interface is English is still an Arabic
 * paper. Kept in step with PAPER_LABELS in the API's docx-writer, so the PDF
 * and the Word file say the same thing.
 */
const LABELS = {
  ar: {
    teacher: 'المدرس',
    subject: 'المادة',
    grade: 'الصف',
    questions: 'عدد الأسئلة',
    time: 'الزمن',
    total: 'الدرجة الكلية',
    pass: 'درجة النجاح',
    student: 'اسم الطالب',
    klass: 'الفصل',
    seat: 'رقم الجلوس',
    instructions: 'تعليمات',
    answerAll: 'أجب عن جميع الأسئلة التالية.',
    minutes: 'دقيقة',
    open: 'غير محدد',
    q: 'س',
    end: 'انتهت الأسئلة — مع تمنياتنا بالتوفيق',
    page: 'صفحة',
    of: 'من',
    marks: (n: number) => `(${n} درجة)`,
    optionLabels: ['أ', 'ب', 'ج', 'د', 'هـ', 'و', 'ز', 'ح'],
  },
  en: {
    teacher: 'Teacher',
    subject: 'Subject',
    grade: 'Grade',
    questions: 'Questions',
    time: 'Time',
    total: 'Total marks',
    pass: 'Pass mark',
    student: 'Student name',
    klass: 'Class',
    seat: 'Seat no.',
    instructions: 'Instructions',
    answerAll: 'Answer all of the following questions.',
    minutes: 'minutes',
    open: 'Untimed',
    q: 'Q',
    end: 'End of the exam — good luck',
    page: 'Page',
    of: 'of',
    marks: (n: number) => `(${n} ${n === 1 ? 'mark' : 'marks'})`,
    optionLabels: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
  },
};

const hasArabic = (s: string) => /[؀-ۿݐ-ݿ]/.test(s);
/** "A) …" already carries its letter; lettering it again printed "A) A) …". */
const hasLabel = (s: string) => /^\s*\(?[A-Za-zء-ي0-9٠-٩]{1,2}\s*[)\].:\-–]\s*/.test(s);

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
      <ExamSheet data={data} />
    </div>
  );
}

/**
 * The paper as it is handed to a class — the same sheet the Word export
 * writes: who set it and for what, the numbers a student checks first, the
 * boxes they fill in, the instructions, then the questions.
 *
 * It used to be a title, a line of meta and the questions — nothing a teacher
 * could hand out as it was.
 */
function ExamSheet({ data }: { data: ExamDocument }) {
  const L = data.rtl ? LABELS.ar : LABELS.en;
  const h = data.header;
  const who = [h?.academy, h?.teacher ? `${L.teacher}: ${h.teacher}` : null].filter(
    (x): x is string => !!x,
  );
  const what = [
    h?.subject ? `${L.subject}: ${h.subject}` : (h?.course ?? null),
    h?.grade ? `${L.grade}: ${h.grade}` : null,
  ].filter((x): x is string => !!x);
  const facts: [string, string][] = [
    [
      L.questions,
      String(h?.questionCount ?? data.sections.reduce((n, s) => n + s.questions.length, 0)),
    ],
    [L.time, data.timeLimitMin ? `${data.timeLimitMin} ${L.minutes}` : L.open],
    [L.total, String(data.totalMarks)],
    ...(h?.passingScore != null ? [[L.pass, `${h.passingScore}%`] as [string, string]] : []),
  ];
  const instructions = data.instructions.length ? data.instructions : [L.answerAll];

  return (
    <article
      dir={data.rtl ? 'rtl' : 'ltr'}
      className="exam-sheet mx-auto w-full max-w-[210mm] bg-white p-[16mm] text-[13.5px] leading-relaxed text-black shadow-elevated print:max-w-none print:p-0 print:shadow-none"
    >
      {/* Page numbers on paper, in the paper's language. Chrome and Edge draw
          @page margin boxes; a browser that does not simply prints none. */}
      <style>{`@page { size: A4; margin: 14mm 14mm 16mm; @bottom-center { content: "${L.page} " counter(page) " ${L.of} " counter(pages); font-size: 10px; color: #555; } }`}</style>

      {/* Who set it, the title, for what */}
      <header className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 border-b-2 border-black pb-3">
        <div className="text-start text-[12.5px] font-bold">
          {who.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
        <h1 className="text-center font-heading text-[22px] font-extrabold">{data.title}</h1>
        <div className="text-end text-[12.5px] font-bold">
          {what.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
      </header>

      {/* The numbers a student checks before starting */}
      <table className="mt-4 w-full table-fixed border-collapse text-center">
        <thead>
          <tr>
            {facts.map(([label]) => (
              <th
                key={label}
                className="border border-black/70 bg-black/[0.06] px-2 py-1.5 text-[12px]"
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            {facts.map(([label, value]) => (
              <td key={label} className="border border-black/70 px-2 py-1.5 text-[14px]">
                {value}
              </td>
            ))}
          </tr>
        </tbody>
      </table>

      {/* What the student fills in */}
      <table className="mt-3 w-full table-fixed border-collapse">
        <tbody>
          <tr>
            <td className="w-[56%] border border-black/70 px-3 py-2.5">
              <b>{L.student}:</b> <span className="text-black/40">……………………………………………</span>
            </td>
            <td className="border border-black/70 px-3 py-2.5">
              <b>{L.klass}:</b> <span className="text-black/40">…………</span>
            </td>
            <td className="border border-black/70 px-3 py-2.5">
              <b>{L.seat}:</b> <span className="text-black/40">…………</span>
            </td>
          </tr>
        </tbody>
      </table>

      <div className="mt-4">
        <p className="font-bold">{L.instructions}</p>
        <ul className="list-disc ps-6">
          {instructions.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </div>

      {data.sections.map((section, si) => (
        <section key={si} className="mt-5">
          {section.title && (
            <h2 className="mb-3 border-b border-black/60 pb-1 font-heading text-[16px] font-bold">
              {section.title}
            </h2>
          )}
          {section.questions.map((q) => {
            // Each question in its own direction — an English question on an
            // Arabic paper otherwise comes out with its punctuation reversed.
            const qRtl = hasArabic(q.text) || (!/[A-Za-z]/.test(q.text) && data.rtl);
            const QL = qRtl ? LABELS.ar : LABELS.en;
            return (
              // A question and its options on one page: a stem at the bottom of
              // page 1 with its answers on page 2 is how a printed exam breaks.
              <div key={q.number} dir={qRtl ? 'rtl' : 'ltr'} className="mb-5 break-inside-avoid">
                <p className="font-bold">
                  {qRtl ? `${QL.q}${q.number}: ` : `${QL.q}${q.number}. `}
                  {q.text}
                  {q.marks != null && (
                    <span className="ms-2 text-[12px] font-normal text-black/60">
                      {QL.marks(q.marks)}
                    </span>
                  )}
                </p>
                {q.options.length > 0 && (
                  <ul className="mt-1.5 space-y-1 ps-8">
                    {q.options.map((option, oi) => (
                      <li key={oi}>
                        {!hasLabel(option) && (
                          <b className="me-1">{QL.optionLabels[oi] ?? oi + 1})</b>
                        )}
                        {option}
                      </li>
                    ))}
                  </ul>
                )}
                {q.writtenAnswer && (
                  <div className="mt-2 space-y-6 ps-6 pt-3">
                    {[0, 1, 2, 3].map((i) => (
                      <div key={i} className="border-b border-dotted border-black/50" />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      ))}

      <p className="mt-8 text-center font-bold">{L.end}</p>
    </article>
  );
}
