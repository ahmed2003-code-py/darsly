import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { ErrorNote, Modal } from './ui';

/** Write / edit the caller's review of a course. Prefills any existing review. */
export default function ReviewModal({
  open, onClose, courseId,
}: { open: boolean; onClose: () => void; courseId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');

  const { data: existing } = useQuery({
    queryKey: ['my-review', courseId],
    queryFn: async () => (await api.get(`/reviews/mine/${courseId}`)).data,
    enabled: open,
  });

  useEffect(() => {
    if (existing) { setRating(existing.rating); setComment(existing.comment ?? ''); }
  }, [existing]);

  const save = useMutation({
    mutationFn: async () => (await api.post('/reviews', { courseId, rating, comment })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['course', courseId] });
      qc.invalidateQueries({ queryKey: ['my-review', courseId] });
      onClose();
    },
  });

  return (
    <Modal open={open} onClose={onClose} title={t('review.title')}>
      <div className="mb-4 flex justify-center gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" onMouseEnter={() => setHover(n)} onMouseLeave={() => setHover(0)}
            onClick={() => setRating(n)} className="text-4xl leading-none transition"
            aria-label={`${n}`}>
            <span className={(hover || rating) >= n ? 'text-accent' : 'text-outline-variant'}>★</span>
          </button>
        ))}
      </div>
      <textarea className="input min-h-[6rem]" dir="auto" value={comment} maxLength={1000}
        onChange={(e) => setComment(e.target.value)} placeholder={t('review.commentPlaceholder')} />
      <ErrorNote error={save.error} />
      <button className="btn-primary mt-4 w-full" disabled={save.isPending || rating < 1} onClick={() => save.mutate()}>
        {save.isPending ? t('common.saving') : t('review.submit')}
      </button>
    </Modal>
  );
}
