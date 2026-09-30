import { useQuery } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import GradeSelect from '../../components/GradeSelect';
import { ErrorNote, Field } from '../../components/ui';
import { api } from '../../lib/api';
import { splitFormError } from '../../lib/errorMessage';
import type { Grade } from '../../lib/stages';
import type { RegisterInput } from '../../lib/centerStudents';

export type StudentFormValues = Required<
  Pick<
    RegisterInput,
    'fullName' | 'gradeId' | 'studentPhone' | 'guardianName' | 'guardianPhone' | 'school'
  >
> & { groupId: string };

export const EMPTY_STUDENT: StudentFormValues = {
  fullName: '',
  gradeId: '',
  studentPhone: '',
  guardianName: '',
  guardianPhone: '',
  school: '',
  groupId: '',
};

const FIELDS = [
  'fullName',
  'gradeId',
  'studentPhone',
  'guardianName',
  'guardianPhone',
  'school',
  'groupId',
];

/**
 * The few things a desk asks a family at the counter. Only the name is
 * required: no email, no password, and no phone for a child who has none.
 * Every field is a real <label>, and the server's refusal for a field is
 * shown under that field.
 */
export default function StudentForm({
  initial,
  groups,
  pending,
  error,
  submitLabel,
  onSubmit,
}: {
  initial: StudentFormValues;
  /** Offered only when registering (enrolling from the edit form is the row's "add to group"). */
  groups?: { id: string; name: string; members: number }[];
  pending: boolean;
  error: unknown;
  submitLabel: string;
  onSubmit: (v: StudentFormValues) => void;
}) {
  const { t } = useTranslation();
  const [v, setV] = useState<StudentFormValues>(initial);
  const { data: grades } = useQuery<Grade[]>({
    queryKey: ['grades'],
    queryFn: async () => (await api.get('/catalog/grades')).data,
    staleTime: 60 * 60_000,
  });
  const { fields, rest } = splitFormError(error, FIELDS);
  const set = (k: keyof StudentFormValues) => (e: { target: { value: string } }) =>
    setV((p) => ({ ...p, [k]: e.target.value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // Enter pressed while the first request is still out must not send a second.
    if (pending) return;
    onSubmit(v);
  };

  const phoneProps = { type: 'tel', inputMode: 'tel' as const, dir: 'ltr', autoComplete: 'off' };
  return (
    <form onSubmit={submit} noValidate>
      <Field label={t('registry.form.fullName')} id="rs-name" error={fields.fullName}>
        <input
          id="rs-name"
          className="input"
          value={v.fullName}
          onChange={set('fullName')}
          required
          maxLength={120}
          autoFocus
          autoComplete="off"
          aria-invalid={!!fields.fullName}
          aria-describedby={fields.fullName ? 'rs-name-error' : undefined}
        />
      </Field>
      <Field label={t('registry.form.grade')} id="rs-grade" error={fields.gradeId}>
        <GradeSelect
          value={v.gradeId}
          onChange={(gradeId) => setV((p) => ({ ...p, gradeId }))}
          grades={grades}
        />
      </Field>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field
          label={t('registry.form.guardianPhone')}
          id="rs-gphone"
          error={fields.guardianPhone}
          hint={t('registry.form.phoneHint')}
        >
          <input
            id="rs-gphone"
            className="input"
            value={v.guardianPhone}
            onChange={set('guardianPhone')}
            maxLength={32}
            placeholder="01xxxxxxxxx"
            aria-invalid={!!fields.guardianPhone}
            {...phoneProps}
          />
        </Field>
        <Field label={t('registry.form.guardianName')} id="rs-gname">
          <input
            id="rs-gname"
            className="input"
            value={v.guardianName}
            onChange={set('guardianName')}
            maxLength={120}
            autoComplete="off"
          />
        </Field>
        <Field label={t('registry.form.studentPhone')} id="rs-sphone" error={fields.studentPhone}>
          <input
            id="rs-sphone"
            className="input"
            value={v.studentPhone}
            onChange={set('studentPhone')}
            maxLength={32}
            placeholder="01xxxxxxxxx"
            aria-invalid={!!fields.studentPhone}
            {...phoneProps}
          />
        </Field>
        <Field label={t('registry.form.school')} id="rs-school">
          <input
            id="rs-school"
            className="input"
            value={v.school}
            onChange={set('school')}
            maxLength={120}
            autoComplete="off"
          />
        </Field>
      </div>
      {groups && (
        <Field
          label={t('registry.form.group')}
          id="rs-group"
          error={fields.groupId}
          hint={t('registry.form.groupHint')}
        >
          <select id="rs-group" className="input" value={v.groupId} onChange={set('groupId')}>
            <option value="">{t('registry.form.noGroup')}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {t('registry.groupOption', { name: g.name, count: g.members })}
              </option>
            ))}
          </select>
        </Field>
      )}
      {rest && <ErrorNote error={error} fields={FIELDS} />}
      <button
        type="submit"
        className="btn-primary mt-2 w-full py-3"
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? t('registry.saving') : submitLabel}
      </button>
    </form>
  );
}
