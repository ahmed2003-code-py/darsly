import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import { Badge, Field, Spinner } from '../../../components/ui';
import { toastError } from '../../../lib/toast';
import {
  DraftQuestion,
  DraftType,
  ExamDraft,
  PaperImport,
  addQuestion,
  allQuestions,
  changeType,
  editQuestion,
  moveQuestion,
  regenerateQuestion,
  removeQuestion,
  setCorrect,
} from '../../../lib/paperImport';

/**
 * One review screen, whichever way the exam got here.
 *
 * This is the point of the studio being one thing: a teacher who photographed
 * an exam and a teacher who had one written from their lectures both end up
 * editing the same list, with the same controls, producing the same exam.
 * Building two of these would have meant every later improvement to one of
 * them quietly not existing in the other.
 *
 * The two paths differ in exactly two places, and both are additions rather
 * than variants: a generated question can be written again, and it names the
 * file and page it came from.
 */
const TYPES: DraftType[] = ['MCQ', 'TRUE_FALSE', 'SHORT_ANSWER'];

export function ExamReviewPanel({
  record,
  draft,
  onDraft,
}: {
  record: PaperImport;
  draft: ExamDraft;
  onDraft: (draft: ExamDraft) => void;
}) {
  const { t } = useTranslation();
  const questions = allQuestions(draft);

  return (
    <>
      <div className="card mb-6">
        <Field label={t('paper.examTitle')}>
          <input
            className="input"
            value={draft.title}
            onChange={(e) => onDraft({ ...draft, title: e.target.value })}
          />
        </Field>
        <p className="text-sm text-outline">{t('paper.questionCount', { n: questions.length })}</p>
      </div>

      <div className="space-y-4">
        {questions.map((question) => (
          <QuestionCard
            key={question.id}
            record={record}
            question={question}
            onChange={(patch) => onDraft(editQuestion(draft, question.id, patch))}
            onType={(type) => onDraft(changeType(draft, question.id, type))}
            onCorrect={(optionId, multi) =>
              onDraft(setCorrect(draft, question.id, optionId, multi))
            }
            onMove={(delta) => onDraft(moveQuestion(draft, question.id, delta))}
            onRemove={() => onDraft(removeQuestion(draft, question.id))}
            onReplace={(next) => onDraft(editQuestion(draft, question.id, next))}
          />
        ))}
      </div>

      <button className="btn-secondary mt-4" onClick={() => onDraft(addQuestion(draft))}>
        {t('paper.addQuestion')}
      </button>
    </>
  );
}

function QuestionCard({
  record,
  question,
  onChange,
  onType,
  onCorrect,
  onMove,
  onRemove,
  onReplace,
}: {
  record: PaperImport;
  question: DraftQuestion;
  onChange: (patch: Partial<DraftQuestion>) => void;
  onType: (type: DraftType) => void;
  onCorrect: (optionId: string, multi: boolean) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  onReplace: (next: Partial<DraftQuestion>) => void;
}) {
  const { t } = useTranslation();
  const [showSource, setShowSource] = useState(false);
  const sourcePage = record.pages.find((p) => p.pageNumber === question.sourcePages[0]);

  // Only a generated question can be written again: there is nothing to write
  // one from on the paper path, where the question is somebody's actual exam.
  const regenerate = useMutation({
    mutationFn: () => regenerateQuestion(record.id, question.id),
    onSuccess: ({ question: next }) => onReplace({ ...next, id: question.id }),
    onError: (e) => toastError(e),
  });

  return (
    <div className="card">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="font-heading font-semibold text-on-surface">{question.number}.</span>
        {question.needsReview && <Badge tone="warn">{t('paper.checkThis')}</Badge>}
        {/* Written by varying another question, to reach the number asked for.
            Marked rather than hidden: a teacher setting this paper is entitled
            to know which questions came from new material and which from a
            second look at the same material. */}
        {question.variant && <Badge tone="neutral">{t('paper.variant')}</Badge>}
        {question.type === 'UNSUPPORTED' && (
          <Badge tone="error">{question.unsupportedKind || t('paper.unsupported')}</Badge>
        )}
        <div className="ms-auto flex flex-wrap gap-1">
          <select
            className="input w-auto py-1 text-sm"
            value={question.type === 'UNSUPPORTED' ? '' : question.type}
            onChange={(e) => onType(e.target.value as DraftType)}
          >
            {question.type === 'UNSUPPORTED' && <option value="">{t('paper.chooseType')}</option>}
            {TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`paper.type.${type}`)}
              </option>
            ))}
          </select>
          {record.kind === 'CONTENT' && (
            <button
              className="btn-ghost px-2"
              disabled={regenerate.isPending}
              onClick={() => regenerate.mutate()}
              title={t('examStudio.regenerateHint')}
            >
              <span className="material-symbols-outlined text-base">
                {regenerate.isPending ? 'hourglass_top' : 'refresh'}
              </span>
              <span className="hidden sm:inline">{t('examStudio.regenerate')}</span>
            </button>
          )}
          <button className="btn-ghost px-2" onClick={() => onMove(-1)} aria-label={t('paper.up')}>
            <span className="material-symbols-outlined text-base">arrow_upward</span>
          </button>
          <button className="btn-ghost px-2" onClick={() => onMove(1)} aria-label={t('paper.down')}>
            <span className="material-symbols-outlined text-base">arrow_downward</span>
          </button>
          <button
            className="btn-ghost px-2 text-error"
            onClick={onRemove}
            aria-label={t('paper.remove')}
          >
            <span className="material-symbols-outlined text-base">delete</span>
          </button>
        </div>
      </div>

      <textarea
        className="input min-h-20"
        value={question.text}
        onChange={(e) => onChange({ text: e.target.value })}
        placeholder={t('paper.questionText')}
      />

      {question.type !== 'SHORT_ANSWER' && question.type !== 'UNSUPPORTED' && (
        <ul className="mt-3 space-y-2">
          {question.options.map((option) => (
            <li key={option.id} className="flex items-center gap-2">
              <button
                type="button"
                className={`material-symbols-outlined text-xl ${option.correct ? 'text-primary' : 'text-outline'}`}
                onClick={() => onCorrect(option.id, false)}
                aria-label={t('paper.markCorrect')}
              >
                {option.correct ? 'radio_button_checked' : 'radio_button_unchecked'}
              </button>
              <input
                className="input"
                value={option.text}
                onChange={(e) =>
                  onChange({
                    options: question.options.map((o) =>
                      o.id === option.id ? { ...o, text: e.target.value } : o,
                    ),
                  })
                }
              />
            </li>
          ))}
        </ul>
      )}

      {question.type === 'SHORT_ANSWER' && (
        <Field label={t('paper.modelAnswer')} hint={t('paper.modelAnswerHint')}>
          <textarea
            className="input"
            value={question.modelAnswer}
            onChange={(e) => onChange({ modelAnswer: e.target.value })}
          />
        </Field>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-outline">
        <label className="flex items-center gap-2">
          {t('paper.marks')}
          <input
            className="input w-20 py-1"
            type="number"
            min={1}
            value={question.marks ?? ''}
            onChange={(e) => onChange({ marks: e.target.value ? Number(e.target.value) : null })}
          />
        </label>
        {/* Where this came from. On the paper path that is a page of the scan;
            on the content path it is the teacher's own lecture file. */}
        {record.kind === 'CONTENT' && question.sourceFile ? (
          <span className="text-on-surface-variant">
            {t('examStudio.source', {
              file: question.sourceFile,
              page: question.sourcePages[0] ?? '',
            })}
          </span>
        ) : (
          sourcePage && (
            <button className="btn-ghost px-2 py-1" onClick={() => setShowSource((v) => !v)}>
              {t('paper.seeSource', { n: sourcePage.pageNumber })}
            </button>
          )
        )}
      </div>

      {showSource && sourcePage && (
        <SourcePage
          importId={record.id}
          pageId={sourcePage.id}
          pageNumber={sourcePage.pageNumber}
        />
      )}
    </div>
  );
}

/**
 * The scan behind a question.
 *
 * Fetched through the API client rather than set as an `<img src>`, because
 * the route is authorized like every other teacher route and an `<img>` cannot
 * send a bearer token. A signed public link would put somebody's unpublished
 * exam paper behind a URL that works without a session.
 */
function SourcePage({
  importId,
  pageId,
  pageNumber,
}: {
  importId: string;
  pageId: string;
  pageNumber: number;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let revoked = false;
    let objectUrl = '';
    api
      .get(`/teacher/paper-imports/${importId}/pages/${pageId}/source`, { responseType: 'blob' })
      .then(({ data }) => {
        if (revoked) return;
        objectUrl = URL.createObjectURL(data as Blob);
        setUrl(objectUrl);
      })
      .catch(() => setUrl(null));
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [importId, pageId]);

  if (!url)
    return (
      <div className="mt-3 grid place-items-center rounded-xl bg-surface-container-low py-10">
        <Spinner />
      </div>
    );
  return (
    <img
      className="mt-3 w-full rounded-xl border border-outline-variant"
      src={url}
      alt={t('paper.page', { n: pageNumber })}
    />
  );
}
