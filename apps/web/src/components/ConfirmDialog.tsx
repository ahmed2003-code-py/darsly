import { useTranslation } from 'react-i18next';
import { useConfirmStore } from '../lib/confirm';
import { Modal } from './ui';

/**
 * Draws whatever `askConfirm()` is currently asking.
 *
 * Mounted once at the root beside `<AppToasts/>`, and for the same reason: a
 * confirmation is asked from screens that render no app shell — a public
 * academy page, an activation link — as well as from inside one.
 *
 * The dialog itself is the shared `Modal`, so this inherits the work already
 * done there: role="dialog", aria-modal, the label wired to the title, a focus
 * trap, Escape to close and focus handed back to whatever opened it. That is
 * the whole reason not to draw a bespoke box here.
 *
 * Every way out except the confirm button answers false. Escape, the backdrop
 * and Cancel are all "no", because the action on the other side of this
 * question deletes a lesson or revokes a student.
 */
export function ConfirmDialog() {
  const { t } = useTranslation();
  const current = useConfirmStore((s) => s.current);
  const answer = useConfirmStore((s) => s.answer);

  return (
    <Modal
      open={current !== null}
      title={current?.title ?? t('common.confirmTitle')}
      onClose={() => answer(false)}
    >
      <p className="whitespace-pre-line text-on-surface-variant">{current?.message}</p>
      <div className="mt-6 flex justify-end gap-2">
        <button
          type="button"
          className="btn-ghost"
          // A destructive question starts on the way back: Enter must not end a
          // class or delete a lesson by reflex.
          autoFocus={!!current?.danger}
          onClick={() => answer(false)}
        >
          {current?.cancelLabel ?? t('common.cancel')}
        </button>
        <button
          type="button"
          // Otherwise autofocused so Enter answers the question the dialog is
          // asking — safe because the focus trap has already moved focus into
          // the panel and the reader has read the title by then.
          autoFocus={!current?.danger}
          className={current?.danger ? 'btn-primary bg-error text-on-error' : 'btn-primary'}
          onClick={() => answer(true)}
        >
          {current?.confirmLabel ?? t('common.confirm')}
        </button>
      </div>
    </Modal>
  );
}
