# Phase 0B — Professional Messenger: Audit & Implementation Plan

Status: **AUDIT + PROPOSAL. Nothing in this document is implemented.**
Written 2026-09-28 against `main` @ `8274929` (Phase 0A live in production).
Every classification below cites the code it was read from.

Phase 0 is split in two:

- **0A — Messaging Foundation** (shipped, verified in production): one
  canonical conversation per pair, race-free first send, `clientMessageId`
  idempotency, newest-first keyset history, bounded list, open-at-newest
  (`8274929`).
- **0B — Professional Messenger** (this document): make the messenger itself
  a product teachers, students — and later assistants and guardians — use
  daily, on a domain model Phase 1/2 can build on without rework.

---

## A. Current-state matrix

Legend: `EXISTS_AND_COMPLETE` · `EXISTS_BUT_PARTIAL` · `BACKEND_ONLY` ·
`FRONTEND_ONLY` · `INFRASTRUCTURE_EXISTS` · `MISSING` · `NEEDS_REDESIGN`

| # | Feature | Status | Evidence |
|---|---|---|---|
| 1 | **Attachments (images / PDF / docs)** | `INFRASTRUCTURE_EXISTS` | No chat attachment model or route: `grep -i attachment` over `apps/api/src/chat` and the messages UI returns nothing. What exists and is reusable: `StorageProvider` (`storage/storage.provider.ts`: private `put/getStream(range)/delete`, local ↔ R2); magic-byte checks `assertFileMatchesMime` (`common/file-signature.ts:91`, signatures for pdf/zip/msword/png/jpeg/webp/text); `sharp` re-encode that strips EXIF (`academy-site/media/academy-media.processor.ts:157` `.rotate()…webp()`); HMAC short-lived signed URLs for `<img>` (`storage/proof-storage.service.ts:84-110`); lesson attachments (`uploads/uploads.controller.ts`: 50 MB, `ATTACHMENT_MIME` allowlist, `Content-Disposition: attachment; filename*=UTF-8''…`, streamed after an access check) |
| 1a | Chat voice notes (the attachment precedent) | `EXISTS_AND_COMPLETE` | `chat.controller.ts` `POST threads/:id/voice` (10 MB, `VOICE_MIME`), private key `chat-voice/<threadId>/<messageId>`, `GET messages/:id/voice` streams with Range **after `canAccessThread`** (`chat.service.ts` `voiceNote()`) |
| 2 | **Reply to message** | `EXISTS_BUT_PARTIAL` | Data model is right and already normalised: `ChatMessage.replyToId` self-relation, `onDelete: SetNull` (schema), same-thread enforcement `replyTarget()` (`chat.service.ts` — "quoting across threads would leak"). DTO `ChatReplyToDto {id, senderName, body, isVoice}` built by join, **not copied**. UI: reply strip above composer, quote inside bubble (`MessagesPage.tsx` ~l.586). **Missing:** quote is a `<div>`, not clickable — no jump-to-original; no "message unavailable" state for a deleted original (the join is filtered by soft-delete middleware → quote silently disappears); quote of an attachment has no indication |
| 3 | **Reactions** | `MISSING` | No model (`grep -i reaction schema.prisma` empty), no route, no event, no UI |
| 4 | **Sender identity / avatars** | `NEEDS_REDESIGN` | Message DTO carries `senderName` + **global** `senderRole` only (`MESSAGE_INCLUDE.sender: {id, fullName, role}`); no avatar per message. Initials = **one character** (`MessagesPage.tsx:526` `charAt(0)`). **Avatars are base64 data URLs stored in `User.avatarUrl`** (`profile.module.ts:111-118`, cap `LIMITS.IMAGE_DATA_URL`); production has 2, avg 55 KB, max 100 KB — and `listThreads` already inlines the counterpart's data URL on every row. Global `role` would label a legacy (TEACHER-role) assistant as "Teacher" — wrong for Phase 1 |
| 5 | **Message actions** | `EXISTS_BUT_PARTIAL` | One action (Reply), a button beside each bubble: hidden until hover on desktop, **permanently visible at 60% on phones** (`max-sm:opacity-60`). No React / Copy / More, no long-press |
| 6 | **Composer** | `EXISTS_BUT_PARTIAL` | Single-line `<input>` (`MessagesPage.tsx:878`) — no multi-line; Enter submits via `<form>`; no Shift+Enter; no IME-composition guard. Has: reply strip, voice recorder, and (0A) optimistic sending / failed / retry / discard. No attachment button, no previews, no progress |
| 7 | **Message state** | `EXISTS_BUT_PARTIAL` | Real states today: `sending` / `failed` (client, 0A), `sent` (stored), and **read** = per-message `readAt`, set for all of the other side's messages when a conversation is opened or polled (`markThreadRead`). Rendered as ✓ / ✓✓ (`Bubble`). **Delivered does not exist** and should not be faked. Two defects: (a) no `chat:read` event is pushed, and the 0A poll only asks for *newer* messages, so ✓→✓✓ on messages already on screen never updates until reopen; (b) `readAt` means "read by *the* other side" — undefined once a side has >1 person (assistants, guardians) |
| 8 | **Dates / timestamps** | `EXISTS_BUT_PARTIAL` | Good base: day separators with Today / Yesterday / date (`groupByDay`, `dayLabel`), time shown only on the last bubble of a run, device-local timezone, `ar-EG` digits. Missing: sticky separator polish, full timestamp on hover/long-press, 5-minute run grouping (grouping is by "same side consecutive", any gap) |
| 9 | **Scroll / new-message UX** | `EXISTS_BUT_PARTIAL` | 0A + `8274929`: opens at newest (verified 12/12 incl. race), older pages keep position (`prepend` anchor), follows new messages only when near bottom (`NEAR_BOTTOM_PX=120`), does **not** jump a reader who scrolled up. **Missing:** "New messages ↓ N" affordance, unread divider on open, jump-to-message (reply) with a way back |
| 10 | **Links & content** | `EXISTS_BUT_PARTIAL` / `INFRASTRUCTURE_EXISTS` | Safe today: plain text, `whitespace-pre-wrap break-words`, no `dangerouslySetInnerHTML` in messages (0 hits). URLs are **not clickable**. A vetted link renderer exists but is private to `lib/markdown.tsx` (`safeHref` allowlist https/mailto/in-app, `Anchor` with `rel="noopener noreferrer nofollow"`). Bubbles have no `dir="auto"`, so an English line in an Arabic UI aligns wrong |
| 11 | **Responsive / mobile** | `EXISTS_BUT_PARTIAL` | List ↔ conversation via `?t=` (browser back works), 360px has no overflow (verified). Weak: the conversation lives inside a card under a page header with the **bottom nav still visible** (`h-[calc(100dvh-17rem)]`), so ~40% of a phone screen is chrome; no safe-area handling inside the composer (the shell's `BottomNav` does use `env(safe-area-inset-bottom)`); touch targets 32–44px mixed |
| 12a | Realtime messages | `EXISTS_AND_COMPLETE` | Socket.IO + Redis adapter; `fanOut` emits `chat:message` to both parties' `user:` rooms, per-viewer payload (`mine`); 0A adds 5 s `after=` polling as a safety net |
| 12b | Realtime reactions | `MISSING` | — |
| 12c | Unread sync | `EXISTS_BUT_PARTIAL` | List refetches on any `chat:message` + every 10 s; no server-pushed unread counts for chat (notifications have `notification:unread`) |
| 12d | Read state realtime | `BACKEND_ONLY` (inbound only) | `MARK_READ` client→server exists (`chat.gateway.ts` `markRead`); nothing is broadcast back |
| 12e | Typing indicator | `EXISTS_BUT_PARTIAL` | `chat:typing` → `TYPING_ECHO` to `thread:` room, access-gated. **Emitted on every keystroke** (`onType` has no throttle) and every event runs `canAccessThread` (a DB query) — wasteful, should be throttled |
| 12f | Presence | `MISSING` | No online state anywhere |
| 13 | **Accessibility** | `EXISTS_BUT_PARTIAL` | Icon buttons have `aria-label`s; `focus-visible` on the reply button. No list semantics / keyboard navigation between conversations or messages, no live region for incoming messages, actions not reachable by keyboard on a focused message |
| 14 | **Performance** | `EXISTS_BUT_PARTIAL` | 0A: keyset pages of 40, list pages of 50, unread in one grouped query, includes batched by Prisma per page (not N+1). Risk: avatar data URLs in payloads (see #4) |
| 15 | **Authorization** | `EXISTS_AND_COMPLETE` (for what exists) | Single gate `canAccessThread` on read/send/voice/socket join/typing; reply target restricted to same thread; cursor must belong to the thread (0A); tested (`chat-access.spec.ts`, `chat.integration.spec.ts`). Role-branching (`user.role === TEACHER`) is Phase 1's job to replace — 0B must route every new resource through the same gate so Phase 1 changes it in one place |
| — | Notifications | `EXISTS_BUT_PARTIAL` | `NotificationsService.create` per message (`fanOut`) → one notification row per message, no coalescing |
| — | Tests | `EXISTS_BUT_PARTIAL` | API: `chat-access.spec.ts` (unit), `chat.integration.spec.ts` (18, real Postgres), `realtime/chat.gateway.spec.ts`; web: `pages/messages/messageList.spec.ts` (10). No browser tests in-repo (verification scripts lived in a session scratchpad) |

---

## B. Architecture proposal

Guiding rule: **every new thing hangs off a message, every message hangs off a
thread, and every access goes through the one thread gate.** Nothing in 0B
knows whether a sender is a teacher or a student — identity is data on the
message, and authorization is the thread's.

### B.1 Data model (one additive migration)

```prisma
/// NEW — a file attached to a message. Bound to its conversation from the
/// moment of upload, so access is the conversation's from the first byte.
model ChatAttachment {
  id          String   @id @default(cuid())
  threadId    String
  thread      ChatThread @relation(fields: [threadId], references: [id], onDelete: Cascade)
  messageId   String?                     // null while PENDING (uploaded, not yet sent)
  message     ChatMessage? @relation(fields: [messageId], references: [id], onDelete: SetNull)
  uploaderId  String
  kind        ChatAttachmentKind          // IMAGE | FILE
  storageKey  String   @unique            // chat-files/<threadId>/<id> — server-generated, never from the client
  previewKey  String?                     // IMAGE only: re-encoded ≤1280px webp
  fileName    String                      // sanitised display name only; never used as a path
  mimeType    String                      // sniffed, not declared
  sizeBytes   Int
  width       Int?
  height      Int?
  sha256      String
  status      ChatAttachmentStatus @default(PENDING)   // PENDING | ATTACHED
  createdAt   DateTime @default(now())
  deletedAt   DateTime?

  @@index([messageId])
  @@index([threadId, createdAt])
  @@index([status, createdAt])            // orphan sweep
}

/// NEW — one reaction per person per message (changing it replaces it).
model ChatReaction {
  id        String      @id @default(cuid())
  messageId String
  message   ChatMessage @relation(fields: [messageId], references: [id], onDelete: Cascade)
  userId    String
  emoji     String      // server-side allowlist, see B.2
  createdAt DateTime    @default(now())
  updatedAt DateTime    @updatedAt

  @@unique([messageId, userId])           // no duplicate reactions, ever — DB-enforced
  @@index([messageId])
}

/// NEW — per-person read position (the Phase-0 plan's D.5, pulled forward).
model ChatReadState {
  threadId   String
  userId     String
  lastReadAt DateTime
  updatedAt  DateTime @updatedAt
  thread     ChatThread @relation(fields: [threadId], references: [id], onDelete: Cascade)
  @@id([threadId, userId])
  @@index([userId])
}

model ChatMessage {
  // … existing fields unchanged (replyToId, audio*, lessonId, clientMessageId, readAt …)
  /// NEW — who the sender was, frozen at send time (never re-labels history):
  /// 'OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT' | 'GUARDIAN' | 'ADMIN'
  senderKind  String?
  senderTitle String?        // e.g. "Student Support" (Phase 1 fills it)
  attachments ChatAttachment[]
  reactions   ChatReaction[]
}
```

Decisions and why:

- **Relational reactions, one per user per message** (`@@unique([messageId,
  userId])`) — counts are a `groupBy`, duplicates are impossible, "who
  reacted" is a join. A JSON blob could not be constrained or indexed.
- **`ChatReadState` now, not in Phase 1** — "Seen" is part of a professional
  messenger, and per-message `readAt` stops meaning anything the moment a
  conversation has two people on one side (Phase 1 team inbox, Phase 2
  guardians). Building "Seen" on `readAt` in 0B would be rebuilt in Phase 1.
  `readAt` keeps being written for one release (dual-write) so old tabs keep
  their ✓✓.
- **Voice notes stay on their columns.** They work, are private and tested;
  moving them into `ChatAttachment` gains nothing in 0B and risks the 1
  production voice note. A later cleanup can migrate them.
- **Reply stays `replyToId`** — no copied snippet. A deleted/hidden original
  is reported as `replyTo: { id, unavailable: true }` instead of vanishing.
- `senderKind` is nullable + backfilled (existing: a message from the thread's
  `staffUserId` → `OWNER`, from the student → `STUDENT`), so the migration
  cannot fail on old rows.

### B.2 Backend

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /chat/attachments` (multipart: `file`, `threadId` **or** target, `clientUploadId`) | thread gate (existing thread) / `authorizeTarget` (first message) | Streams to a temp file (multer disk, like lessons) → size cap → `assertFileMatchesMime` → images: `sharp().rotate()` re-encode to webp (strips EXIF/GPS, kills polyglots) + preview → `put(chat-files/<threadId>/<id>)` → row PENDING. Returns `{id, kind, name, size, previewUrl}`. For a first message the thread is resolved with the 0A atomic path (an attachment is an intent to send) |
| `DELETE /chat/attachments/:id` | uploader, PENDING only | remove from composer |
| `POST /chat/messages` | unchanged + `attachmentIds[]` (≤ 5) | `body` may be empty **iff** attachments present. Bind = `updateMany where {id in ids, uploaderId: me, threadId, status: PENDING}` inside the send transaction; count mismatch → 400. `clientMessageId` replay still returns the original |
| `GET /chat/attachments/:id` (`?download=1`) | thread gate | `nosniff`, `Cache-Control: private`, `Content-Disposition` inline for images / attachment for files, filename RFC 5987-encoded |
| Signed image URLs in DTOs | issued only after the gate | generalise the proof signer (`HMAC(key, exp)`), 10-min TTL — lets `<img>` and the lightbox work without a bearer header |
| `PUT /chat/messages/:id/reaction` `{emoji}` / `DELETE …/reaction` | thread gate on the message's thread; message not deleted | upsert on `(messageId,userId)`; emoji allowlist `👍 ❤️ 😂 😮 😢 🙏`; throttled |
| `GET /chat/threads/:id/messages?around=<messageId>` | thread gate; cursor must be in thread | window of 20 before + 20 after — jump to a replied message not yet loaded |
| `POST /chat/threads/:id/read` `{upTo}` | thread gate | monotonic `GREATEST`; replaces the implicit mark-on-fetch (kept for old tabs) |
| `GET /users/:id/avatar?v=&e=&t=` | signed URL | decodes the stored data URL (or a future storage key), ETag + long cache; DTOs carry this URL instead of the base64 — **payload drops from ~55 KB per avatar to ~120 bytes** |

**Message DTO (additive — old fields stay):**
```ts
{ …existing,
  sender: { id, name, avatarUrl: string|null, kind: 'OWNER'|'TEACHER'|'ASSISTANT'|'STUDENT'|'GUARDIAN'|'ADMIN', title: string|null },
  attachments: { id, kind, name, mimeType, size, width?, height?, url, previewUrl? }[],
  reactions: { emoji, count, mine: boolean }[],          // aggregated
  replyTo: { id, senderName, body, isVoice, attachmentKind?: 'IMAGE'|'FILE', unavailable?: true } | null }
```
Per page: messages (1) + includes batched by Prisma (sender, replyTo, attachments) + **one `groupBy` for reaction counts** + one query for "mine" — constant, no N+1.

### B.3 Socket.IO events

| Event (server → client) | Rooms | Payload |
|---|---|---|
| `chat:message` (existing) | `user:<id>` of everyone with access | now includes attachments/reactions |
| `chat:reaction` (NEW) | same | `{threadId, messageId, reactions:[{emoji,count}], actorId}` — client computes `mine` |
| `chat:read` (NEW) | `user:<id>` of the other participants | `{threadId, userId, lastReadAt}` — drives ✓✓ live |
| `chat:typing` (existing) | `thread:<id>` | **client-throttled to 1 per 3 s**, server drops >1/s per socket |

Principle: events are **hints**, the database is the truth. On socket
reconnect the client refetches the open page (`after=`), so a missed event is
never a lasting inconsistency. Recipients are computed by one function from
the thread's access rule, so Phase 1 (team members) changes it in one place.

**Presence: not in 0B.** Reliable presence across Railway replicas needs
TTL'd Redis state and heartbeat handling; a wrong "online" is worse than
none, and it is privacy-sensitive for teachers. Recommend later, deliberately.

### B.4 Frontend (the structure the Phase 0A plan named)

```
apps/web/src/pages/messages/
  MessagesPage (route shell)          ConversationList, ConversationRow
  Conversation (header + timeline)    MessageTimeline (virtual-ish: pages, anchors, pills)
  MessageBubble                       SenderLine (Avatar + name · role)
  ReplyQuote (clickable)              AttachmentCard / ImageAttachment / Lightbox
  ReactionBar + ReactionPicker        MessageActions (hover toolbar · long-press sheet)
  Composer (textarea, attach, previews, reply strip, voice)
  NewMessagesPill, UnreadDivider, DayDivider
  useConversation (0A, extended: reactions, around-window, read)
  useUploads (progress via XHR upload events, retry, cancel)
  messageList.ts (0A merge, extended for reactions/attachments)
apps/web/src/components/Avatar.tsx    (reusable: image or initials, see C.2)
apps/web/src/lib/linkify.tsx          (exports safeHref/Anchor from lib/markdown)
```
`MessagesPage.tsx` stops growing; its pieces move into these files.

### B.5 Authorization — the invariants 0B adds (all service-layer)

1. React / reply / read / attachment-fetch all resolve `message → thread →
   canAccessThread(user, thread)`; no endpoint takes a thread id it does not
   re-check.
2. Inaccessible and non-existent resources answer identically (same status,
   same body) — no metadata inference from ids.
3. Attachments: server-generated keys, sniffed type, allowlist, per-file and
   per-user-per-day caps, bind only own PENDING uploads of the same thread.
4. A reply target must be in the same thread (existing) and not deleted.
5. Reaction emoji from an allowlist; one row per user per message.

---

## C. UI / UX proposal

### C.1 Desktop (≥1024px)

```
┌ Messages ──────────────┬───────────────────────────────────────────────┐
│ 🔍 Search               │ ◯ TEST · مدرس اختبار                ⋯        │
│ ─────────────────────── │   Physics · online status: none               │
│ ◯ Ahmed Ali     10:42 ②│ ────────────────── Yesterday ───────────────  │
│   You: ok…              │ ◯ Ahmed Ali · Student                         │
│ ◯ Sara Adel     09:10   │   I couldn't open lesson 5                    │
│   📎 homework.pdf       │   ┌──────────────────────┐                    │
│                         │   │ 📄 homework.pdf       │   10:40            │
│                         │   │ PDF · 2.4 MB  Open ↗  │                    │
│                         │   └──────────────────────┘                    │
│                         │                     ┌ ↩ Ahmed: I couldn't… ┐   │
│                         │                     │ Try now — fixed ✅    │   │
│                         │                     └──────── 10:42 ✓✓ ────┘   │
│                         │                        👍 1                    │
│                         │           ─── New messages ───                 │
│                         │                         [ ↓ 3 new ]            │
│                         │ ┌──────────────────────────────────────────┐   │
│                         │ │ ↩ Replying to Ahmed: I couldn't open…  ✕ │   │
│                         │ │ [🖼 photo.jpg ▓▓▓▓░ 70%] [📄 notes.pdf ✕] │   │
│                         │ │ ＋  Write a message…               🎙  ➤ │   │
│                         │ └──────────────────────────────────────────┘   │
└─────────────────────────┴───────────────────────────────────────────────┘
```

- **Identity:** incoming runs start with `Avatar` + `Name · Role` (role in
  `on-surface-variant`, never a coloured chip); following bubbles of the same
  run within 5 minutes indent under it with no repeated name. Own messages:
  no avatar, no name.
- **Bubbles:** own = `primary` soft fill, other = `surface-container`; 12px
  radius with a smaller corner on the tail side; max width 70ch; `dir="auto"`
  per bubble; text links via `linkify` (https/mailto/in-app only).
- **Actions (desktop):** on hover/focus of a bubble, a small floating toolbar
  appears at its top edge: Reply · React · Copy · ⋯ (More: "Copy link to
  message" later). Keyboard: Tab to a message, Enter opens the toolbar.
- **Reactions:** chips under the bubble (`👍 2`), own reaction highlighted;
  tooltip lists names. Picker = one row of 6 emoji.
- **Reply quote:** clickable → scrolls to the original and flashes it for
  1 s; if not loaded, fetches the `around` window and shows "Jump to latest".
  Deleted original: "Message unavailable" in italic.
- **Attachments:** images render inline (max 320px tall, rounded, blur-up
  from the preview), click → lightbox with download; files render as a card:
  type icon, name (middle-ellipsis, `<bdi>`), type · size, Open/Download.
- **Time:** only on the last bubble of a run; full date-time on hover
  (`title`). Day dividers: Today / Yesterday / weekday (≤6 days) / date.
- **Scroll:** open at newest, or at the first unread with an "New messages"
  divider when there are unread messages; reading older → incoming messages
  never move the view, a `↓ N new` pill appears; own sends always scroll down.
- **Composer:** auto-growing textarea 1–6 lines; **Enter sends, Shift+Enter
  newline** on devices with a hardware keyboard; IME-composition guard (Arabic
  keyboards); attach button opens file picker (multi-select); drag-and-drop
  and paste-image on desktop; chips with per-file progress, ✕, and Retry on
  failure; send disabled until text or all uploads done.
- **Read state:** ✓ sent, ✓✓ seen (from the other participant's read cursor),
  ⏱ sending, ⚠ failed. No "delivered".

### C.2 Avatar component (reusable across the app)

- Image when `avatarUrl` loads; `onError` → initials (never a broken image).
- Initials: first letter of the first and last word (`Ahmed Mohamed` → `AM`,
  `Ahmed` → `A`, Arabic `أحمد محمد` → `أم`), skipping honorifics
  (`أ.` / `د.` / `Mr.`), uppercase Latin.
- Background from a deterministic hash of the user id into the theme's
  existing soft fills (no new colours; contrast-checked per UI-CONVENTIONS).

### C.3 Mobile (≤768px, incl. 360px)

- Conversation is **full-screen**: the page header and bottom nav are hidden
  on `/messages?t=…` (back arrow in the conversation header; Android back
  works because it is a route).
- Height = `100dvh` with `visualViewport` resize handling; composer pinned
  with `env(safe-area-inset-bottom)`; the keyboard never covers it.
- **Long-press** a bubble (450 ms, with haptic where supported) opens a bottom
  sheet: reaction row on top, then Reply · Copy · (More). Swipe-to-reply is a
  later nicety, not 0B.
- Attach → native sheet (`accept="image/*,application/pdf,.doc,.docx,…"`,
  `multiple`) = camera / gallery / files.
- Touch targets ≥ 44px; no permanently visible per-message buttons.

### C.4 States

Skeleton rows for the list, skeleton bubbles for history; empty conversation
("No messages yet. Start a conversation with Ali."); error with Retry for a
failed page; offline banner while the socket is down ("Reconnecting —
messages still arrive").

---

## D. Scope

### MUST HAVE before Phase 1

1. Attachments (images, PDF, Word/Excel/PowerPoint, TXT) — upload progress,
   retry, previews, lightbox, file cards, secure download, mobile picking.
2. Reply — clickable quote, jump-to-original (incl. `around` fetch), unavailable state.
3. Reactions — 6 emoji, one per user per message, realtime, long-press on mobile.
4. Sender identity — `Avatar` component, `sender{…}` DTO, `senderKind`
   snapshot, avatar URL endpoint (removes base64 from payloads).
5. Message actions — hover toolbar (desktop), long-press sheet (mobile), Copy.
6. Composer — textarea, Enter/Shift+Enter + IME guard, attachments, previews.
7. Read receipts on `ChatReadState` + `chat:read` event (✓ / ✓✓ live).
8. Scroll — unread divider, `↓ N new` pill, jump-and-return; keeps 0A + `8274929`.
9. Content — safe linkify, `dir="auto"`, long-string wrapping.
10. Mobile full-screen conversation + keyboard/safe-area handling.
11. Typing throttle (small fix to an existing feature).
12. Accessibility basics (labels, focus, keyboard reach for actions, live region).
13. Icon font made reliable (see the separate icon report) — the messenger
    is icon-heavy.

### CAN WAIT

Presence/online · message edit & delete-for-everyone · forwarding · in-thread
search · link previews (unfurling fetches arbitrary URLs = SSRF surface) ·
migrating voice notes into attachments · antivirus scanning (ClamAV) ·
notification coalescing (planned with Phase 2) · swipe-to-reply · pinned
messages · drafts persistence per conversation.

Estimated effort for MUST HAVE: **~9–12 working days**, in four slices that
each ship on their own: (1) identity + composer + actions shell,
(2) attachments, (3) reactions + read receipts + events, (4) scroll/jump +
mobile full-screen + a11y + icons.

---

## E. Migration & compatibility

| Question | Answer |
|---|---|
| DB migration required? | **Yes, one, additive only**: 3 new tables, 2 nullable columns on `ChatMessage`, indexes. No drops, no renames, no NOT NULL on existing data. Hand-written, idempotent guards, dry-run on a PG 18 copy of production first (same procedure as 0A) |
| Existing 61 production messages | Fully compatible: no attachments, no reactions (empty arrays), `replyTo` unchanged, `senderKind` backfilled from thread + sender, `ChatReadState` seeded from `readAt` so ✓✓ is identical before/after |
| Existing conversations after deploy | Open exactly as now, with avatars/initials and the new actions available |
| API contract | Additive. `body` rule relaxes only when `attachmentIds` is present. `counterpartAvatarUrl`/avatar fields change from a data URL to a URL — both are valid `<img src>`, so old clients render them |
| Old frontend tabs | Keep working: new DTO fields are ignored; an attachment-only message shows the existing "message this build cannot draw" fallback (`MessagesPage.tsx` `messages.unsupported`); reactions are invisible to them; implicit mark-read on fetch stays for one release |
| Rollback | Code rollback is safe (new tables simply unused). Data written by 0B (attachments, reactions) remains but is invisible to old code. Migration is forward-only by design; a code rollback never needs a schema rollback |

---

## F. Test plan

- **Unit:** initials (Arabic, Latin, honorifics, single name, emoji names);
  linkify (javascript:/data: refused, trailing punctuation, RTL); reaction
  aggregation; merge of reactions/attachments into `messageList`; Enter /
  Shift+Enter / IME rules; upload state machine.
- **API integration (real Postgres):** send with attachments (bind, count
  mismatch, other user's PENDING, other thread's PENDING, already-ATTACHED);
  body-empty-with-attachments; replay of an attachment send with the same
  `clientMessageId`; reaction upsert/replace/remove, concurrency (20 parallel
  reacts by one user → 1 row); `around` window correctness; read cursor
  monotonicity; `senderKind` backfill.
- **Authorization / isolation:** react, reply-to, read, `around`, attachment
  GET and DELETE, avatar URL — each from another student, another academy's
  teacher, no token, expired/tampered signed URL → identical refusal, no
  side effect.
- **Attachment security:** MIME spoof (PDF bytes declared PNG), SVG/HTML/EXE
  refused, oversize, EXIF GPS stripped, filename with `../` / RTL override /
  `<script>` rendered inert, `Content-Disposition` encoding, daily quota,
  orphan sweep (PENDING > 24 h) never touching ATTACHED.
- **Socket.IO:** `chat:reaction` / `chat:read` reach exactly the allowed users
  and nobody else; typing throttle; reconnect → refetch closes gaps.
- **Browser (desktop + 360px + tablet 768px), production-style:** send image
  + PDF from a phone picker, progress, failed upload + retry; reply + jump to
  an unloaded original and back; long-press sheet; reaction live on the other
  side; ✓→✓✓ live; `↓ N new` while reading history; RTL/LTR mixed text;
  keyboard-open composer at 360px; no overflow; screenshots reviewed by eye.
- **Race:** two tabs reacting simultaneously; send while an upload finishes;
  reply to a message deleted meanwhile; list-vs-messages race (`8274929`).
- **Regression:** the whole 0A suite (18 integration + unit + the production
  smoke script re-run with the TEST accounts).

---

## G. Risks

| Risk | Where | Mitigation |
|---|---|---|
| Data loss | migration | additive only; dry run on a PG 18 production copy; fresh verified dump before push |
| Duplicate messages | attachment sends retried | the same `clientMessageId` replays; attachments bind once (PENDING→ATTACHED in the send transaction) |
| Cross-academy / cross-conversation leakage | attachments, reactions, `around`, avatar URLs | one gate (B.5), signed URLs bound to the object id + expiry, identical refusal, explicit isolation tests |
| Leaking minors' photos | avatars, image EXIF | signed avatar URLs (not public by user id); re-encode strips EXIF/GPS |
| Storage abuse | uploads | per-file caps (images 10 MB, files 20 MB), 5 per message, per-user daily byte budget via the Redis throttler, orphan sweep |
| Malicious files | uploads | sniff + allowlist + re-encode images; documents always `attachment`; `nosniff`; no SVG/HTML; AV scanning deferred (documented) |
| Realtime inconsistency | reactions/read | events are hints; reconnect refetch; server is truth |
| Performance | payloads, reactions | avatar URLs instead of base64; reaction counts in one `groupBy` per page; typing throttle |
| Broken old conversations | DTO/UI | additive DTO; old-client fallbacks verified; 0A regression suite |
| External dependency | icon font | self-host (icon report) |

---

## Separate report — the desktop icon-font issue

**How icons load today** (`apps/web/index.html:36-44`): only from Google Fonts —
`Material Symbols Outlined` stylesheet (preloaded) with `display=block`. There
is **no icon package** in `apps/web/package.json`; every icon in the app is a
`material-symbols-outlined` ligature span.

**What happens when the request is slow or blocked:** `display=block` hides
the text for the ~3 s block period, then the browser falls back to a normal
font and paints the **ligature names as words** (`search`, `mic`, `done`…).
That is exactly the `se` / `mi` / `do` seen in the headless desktop capture —
the text is clipped by the icon boxes.

**Normal browser or only headless?** Not settled. In this session the font
failed to load in headless desktop runs (with no failed request logged) but
loaded in the 360px runs, and headless Chrome here also showed a transient
`ERR_CERT_VERIFIER_CHANGED` on external requests — so the environment is
suspect. The measurement of the font file (size/latency) could not be run
because the shell's permission check was failing at the time of writing.
What *is* certain without it: the app has a hard runtime dependency on
`fonts.googleapis.com` + `fonts.gstatic.com`, and any user on a network where
Google Fonts is slow or blocked sees words instead of icons across the whole
product.

**Recommendation:** self-host a **subset** of Material Symbols — only the
icon names the app uses (Google's API supports `&icon_names=…`; a build
script can collect them from `src/`) — as a woff2 in `apps/web/public/fonts`
with a local `@font-face`, `font-display: block`, and a preload. Same
glyphs, no visual change, no third-party request, and a far smaller file
than the full variable font. Switching to an SVG icon package would be the
more robust long-term option but touches every icon in the app; not worth it
now.
