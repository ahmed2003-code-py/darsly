import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { api, apiOrigin } from '../../../lib/api';
import { ErrorNote, Spinner } from '../../../components/ui';
import type { Media, MediaKind } from './types';

const ACCEPT = 'image/png,image/jpeg,image/webp';

function mediaSrc(m: Media): string {
  return m.url ? `${apiOrigin()}${m.url}` : '';
}

export default function MediaManager() {
  const qc = useQueryClient();
  const list = useQuery<Media[]>({
    queryKey: ['studio-media'],
    queryFn: async () => (await api.get('/academy/media')).data,
    retry: false,
    // Poll while anything is still processing.
    refetchInterval: (q) =>
      (q.state.data ?? []).some((m) => m.status === 'UPLOADING' || m.status === 'PROCESSING') ? 2000 : false,
  });

  const upload = useMutation({
    mutationFn: async ({ kind, file }: { kind: MediaKind; file: File }) => {
      const fd = new FormData();
      fd.append('kind', kind);
      fd.append('file', file);
      return (await api.post('/academy/media', fd)).data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['studio-media'] }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/academy/media/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['studio-media'] }),
  });

  if (list.isLoading) return <Spinner />;
  if (list.isError) return <div className="card"><ErrorNote error={list.error} /></div>;

  const media = list.data ?? [];
  const byKind = (k: MediaKind) => media.filter((m) => m.kind === k);
  const doUpload = (kind: MediaKind, file?: File) => file && upload.mutate({ kind, file });

  return (
    <div className="space-y-6">
      <div className="card">
        <h2 className="mb-1 font-heading text-xl font-bold">صور الأكاديمية</h2>
        <p className="text-sm text-on-surface-variant">
          الشعار وصورة الغلاف ومعرض الصور. الصيغ المدعومة: PNG / JPEG / WebP (حتى 10MB).
        </p>
        <ErrorNote error={upload.error} />
      </div>

      <SingleSlot title="الشعار" kind="LOGO" item={byKind('LOGO')[0]}
        onUpload={(f) => doUpload('LOGO', f)} onRemove={(id) => remove.mutate(id)} busy={upload.isPending} />
      <SingleSlot title="صورة الغلاف" kind="COVER" item={byKind('COVER')[0]}
        onUpload={(f) => doUpload('COVER', f)} onRemove={(id) => remove.mutate(id)} busy={upload.isPending} />
      <GallerySlot items={byKind('GALLERY')}
        onUpload={(f) => doUpload('GALLERY', f)} onRemove={(id) => remove.mutate(id)} busy={upload.isPending} />
    </div>
  );
}

function StatusChip({ item }: { item: Media }) {
  if (item.status === 'READY') return null;
  if (item.status === 'REJECTED')
    return <span className="text-xs font-bold text-error">مرفوضة{item.rejectReason ? ` — ${item.rejectReason}` : ''}</span>;
  return <span className="text-xs font-bold text-amber-600">جارٍ المعالجة…</span>;
}

function Thumb({ item, onRemove }: { item: Media; onRemove: (id: string) => void }) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-outline-variant bg-surface-container-low">
      {item.status === 'READY' && item.url ? (
        <img src={mediaSrc(item)} alt="" className="h-32 w-full object-cover" loading="lazy" />
      ) : (
        <div className="grid h-32 w-full place-items-center"><StatusChip item={item} /></div>
      )}
      <button type="button" onClick={() => onRemove(item.id)} aria-label="حذف"
        className="absolute end-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-black/60 text-white opacity-0 transition group-hover:opacity-100">
        <span className="material-symbols-outlined text-[18px]">delete</span>
      </button>
    </div>
  );
}

function UploadButton({ label, onFile, busy }: { label: string; onFile: (f?: File) => void; busy: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="btn-secondary" disabled={busy} onClick={() => ref.current?.click()}>
        <span className="material-symbols-outlined text-[20px]">upload</span>
        {busy ? 'جارٍ الرفع…' : label}
      </button>
      <input ref={ref} type="file" accept={ACCEPT} className="hidden"
        onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
    </>
  );
}

function SingleSlot({ title, item, onUpload, onRemove, busy }: {
  title: string; kind: MediaKind; item?: Media; onUpload: (f?: File) => void; onRemove: (id: string) => void; busy: boolean;
}) {
  return (
    <div className="card">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-heading font-bold">{title}</h3>
        <UploadButton label={item ? 'استبدال' : 'رفع'} onFile={onUpload} busy={busy} />
      </div>
      {item ? (
        <div className="max-w-xs"><Thumb item={item} onRemove={onRemove} /></div>
      ) : (
        <p className="text-sm text-on-surface-variant">لم تُرفع صورة بعد.</p>
      )}
    </div>
  );
}

function GallerySlot({ items, onUpload, onRemove, busy }: {
  items: Media[]; onUpload: (f?: File) => void; onRemove: (id: string) => void; busy: boolean;
}) {
  return (
    <div className="card">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-heading font-bold">معرض الصور <span className="text-sm font-normal text-on-surface-variant">({items.length}/12)</span></h3>
        {items.length < 12 && <UploadButton label="إضافة صورة" onFile={onUpload} busy={busy} />}
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-on-surface-variant">المعرض فارغ.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {items.map((m) => <Thumb key={m.id} item={m} onRemove={onRemove} />)}
        </div>
      )}
    </div>
  );
}
