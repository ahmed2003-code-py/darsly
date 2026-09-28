import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatAttachmentDto } from '@darsly/shared-types';
import { api } from '../../lib/api';
import type { SendTarget } from './useConversation';

export const MAX_FILES = 5;
export const IMAGE_MAX = 10 * 1024 * 1024;
export const FILE_MAX = 20 * 1024 * 1024;
/** What the picker offers; the server decides from the bytes regardless. */
export const ACCEPT =
  'image/jpeg,image/png,image/webp,application/pdf,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt';
const DOC_EXT = /\.(pdf|docx?|xlsx?|pptx?|txt)$/i;

export interface UploadItem {
  key: string;
  file: File;
  name: string;
  size: number;
  isImage: boolean;
  /** Instant local thumbnail for images, before the upload finishes. */
  localUrl: string | null;
  progress: number;
  status: 'uploading' | 'done' | 'failed';
  error?: string;
  attachment?: ChatAttachmentDto;
}

/**
 * Files being attached to the next message.
 *
 * Each file uploads on its own as soon as it is picked (so Send is instant
 * once they finish), with its own progress, cancel, retry and remove. Uploading
 * never creates a conversation: before the first message the upload is aimed
 * at the person (`studentId`/`tenantId`) and the server ties it to the
 * conversation that will exist; Send creates it.
 */
export function useUploads(
  target: SendTarget | null,
  messages: { tooLarge: string; badType: string; tooMany: string; failed: string },
) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(
    () => () => {
      controllers.current.forEach((c) => c.abort());
      itemsRef.current.forEach((i) => i.localUrl && URL.revokeObjectURL(i.localUrl));
    },
    [],
  );

  const patch = (key: string, p: Partial<UploadItem>) =>
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...p } : i)));

  const start = useCallback(
    (item: UploadItem) => {
      const t = targetRef.current;
      if (!t) return;
      const ctrl = new AbortController();
      controllers.current.set(item.key, ctrl);
      const fd = new FormData();
      fd.append('file', item.file, item.name);
      if ('threadId' in t) fd.append('threadId', t.threadId);
      if ('studentId' in t) fd.append('studentId', t.studentId);
      if ('tenantId' in t) fd.append('tenantId', t.tenantId);
      if ('staffUserId' in t) fd.append('staffUserId', t.staffUserId);
      if ('academyId' in t && t.academyId) fd.append('academyId', t.academyId);
      patch(item.key, { status: 'uploading', progress: 0, error: undefined });
      api
        .post<ChatAttachmentDto>('/chat/attachments', fd, {
          signal: ctrl.signal,
          onUploadProgress: (e) => {
            if (e.total) patch(item.key, { progress: Math.min(0.99, e.loaded / e.total) });
          },
        })
        .then(({ data }) => patch(item.key, { status: 'done', progress: 1, attachment: data }))
        .catch((e) => {
          if (ctrl.signal.aborted) return;
          patch(item.key, {
            status: 'failed',
            error: e?.response?.data?.message ?? messages.failed,
          });
        })
        .finally(() => controllers.current.delete(item.key));
    },
    [messages.failed],
  );

  /** Returns an error to show when some files were refused before uploading. */
  const add = useCallback(
    (files: FileList | File[]): string | null => {
      let error: string | null = null;
      const room = MAX_FILES - itemsRef.current.length;
      const picked = Array.from(files);
      if (picked.length > room) error = messages.tooMany;
      const accepted: UploadItem[] = [];
      for (const file of picked.slice(0, Math.max(0, room))) {
        const isImage = /^image\/(jpeg|png|webp)$/.test(file.type);
        if (!isImage && !DOC_EXT.test(file.name)) {
          error = messages.badType;
          continue;
        }
        if (file.size > (isImage ? IMAGE_MAX : FILE_MAX)) {
          error = messages.tooLarge;
          continue;
        }
        accepted.push({
          key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          file,
          name: file.name,
          size: file.size,
          isImage,
          localUrl: isImage ? URL.createObjectURL(file) : null,
          progress: 0,
          status: 'uploading',
        });
      }
      if (accepted.length) {
        setItems((prev) => [...prev, ...accepted]);
        accepted.forEach(start);
      }
      return error;
    },
    [messages.badType, messages.tooLarge, messages.tooMany, start],
  );

  const retry = useCallback(
    (key: string) => {
      const item = itemsRef.current.find((i) => i.key === key);
      if (item) start(item);
    },
    [start],
  );

  /** Cancel an upload in flight, or remove a finished one (and its server copy). */
  const remove = useCallback((key: string) => {
    const item = itemsRef.current.find((i) => i.key === key);
    controllers.current.get(key)?.abort();
    if (item?.attachment)
      void api.delete(`/chat/attachments/${item.attachment.id}`).catch(() => undefined);
    if (item?.localUrl) URL.revokeObjectURL(item.localUrl);
    setItems((prev) => prev.filter((i) => i.key !== key));
  }, []);

  /** After a send: the files belong to the message now — drop them from the composer only. */
  const clear = useCallback(() => {
    itemsRef.current.forEach((i) => i.localUrl && URL.revokeObjectURL(i.localUrl));
    setItems([]);
  }, []);

  return {
    items,
    add,
    retry,
    remove,
    clear,
    busy: items.some((i) => i.status === 'uploading'),
    failed: items.some((i) => i.status === 'failed'),
    doneAttachments: items
      .filter((i) => i.status === 'done' && i.attachment)
      .map((i) => i.attachment!),
  };
}
