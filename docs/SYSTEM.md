# درسلي — المرجع الكامل للنظام (System Reference)

> ملف واحد يشرح **كل** حاجة: المعمارية، قاعدة البيانات، منطق كل موديول في الباك،
> خريطة الـAPI كاملة، الحماية بالتفصيل حرفياً، ونظام الفرونت (الصفحات، المكوّنات،
> الديزاين توكنز، الأداء). اقرأه من فوق لتحت وهتفهم السستم كله.
>
> ملفات مكمّلة: [`DEPLOYMENT.md`](./DEPLOYMENT.md) (النشر)،
> [`android-payment-listener.md`](./android-payment-listener.md) (تطبيق استقبال الدفع).

---

## 0) نظرة عامة

**درسلي** منصّة دروس عربية (RTL, EGP) لأكتر من مدرّس. كل مدرّس = "tenant" مستقل،
والفلوس كلها مركزية في المنصّة ومتتبّعة في دفتر أستاذ (ledger)، وكل مدرّس بيسحب
نصيبه شهرياً.

### الأدوار
- **STUDENT** — يسجّل بنفسه ويدخل فوراً.
- **TEACHER** — يسجّل → `PENDING` لحد ما الأدمن يوافق.
- **SUPER_ADMIN** — يدير المنصّة كلها.

الجميع بيدخل بـ**إيميل + باسورد** (مفيش OTP في تدفّق الدخول الحالي).

### الـStack (Monorepo)
```
darsly/
├── apps/api          NestJS + Prisma + PostgreSQL + Socket.io   (الباك)
├── apps/web          React + Vite + Tailwind + Framer Motion    (الفرونت, RTL, PWA)
├── packages/shared-types   أنواع/enums مشتركة بين الاتنين
└── docs/             التوثيق
```
النشر **خدمة واحدة**: بناء الـapi بيبني الـweb كمان، والـapi بيقدّم `apps/web/dist`
على `/` والـAPI تحت `/api/v1`. (تفاصيل في `DEPLOYMENT.md`.)

---

## 1) طبقة البيانات (Prisma / PostgreSQL)

المصدر الوحيد للحقيقة: [`apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma).

### اتفاقيات أساسية (مهمة جداً)
- **Multi-tenancy**: أي صف مملوك لمدرّس بيحمل `tenantId` (= `TeacherProfile.id`)،
  وكل استعلام في الـAPI متقيّد بالـtenant.
- **الفلوس بالقرش (piasters)**: كل المبالغ `Int` بالقرش (1 جنيه = 100 قرش) — عشان
  نتجنّب أخطاء الكسور العشرية (float drift).
- **Soft delete**: الموديولات دي مبتتمسحش فعلياً؛ بيتحط فيها `deletedAt` وبتختفي من
  كل القراءات تلقائياً عن طريق Prisma middleware:
  `Course, CourseUnit, Lesson, Attachment, VideoNote, Coupon, PayoutMethodSaved, LiveSession`.

### الجداول مجمّعة حسب المجال

**الهوية والدخول**
| Model | الغرض |
|---|---|
| `User` | حساب موحّد لكل الأدوار: `email/phone` (unique), `passwordHash` (argon2), `role`, `failedLogins`, `lockedUntil` (قفل بعد محاولات فاشلة) |
| `PasswordResetToken` | توكن إعادة كلمة السر (hash, single-use, ينتهي بعد ٣٠ دقيقة) |
| `OtpCode` | كود OTP (غير مستخدم في الدخول حالياً — بنية جاهزة للمستقبل) |
| `DeviceSession` | جلسة لكل جهاز؛ الـrefresh token متربوط بيها (rotation + سقف أجهزة + kick) |

**المدرّسون والطلاب**
| Model | الغرض |
|---|---|
| `TeacherProfile` | = الـtenant. `slug`, `status`, `commissionPercent` (افتراضي 20%), `maxConcurrentSessions` |
| `StudentProfile` | streaks (`currentStreak/longestStreak`), `weeklyGoalLessons`, اهتمامات |
| `SavedCourse` | قائمة حفظ الطالب (wishlist) |

**الكتالوج والمحتوى**
| Model | الغرض |
|---|---|
| `Subject`, `GradeLevel` | التصنيف (مادة/صف) للاكتشاف والفلترة |
| `TeacherGrade`, `StudentInterest` | علاقات many-to-many |
| `Course` | `pricingModel` (ONE_TIME / MONTHLY_SUBSCRIPTION / BUNDLE), `priceCents`, قواعد وصول (`accessWindowDays`, `defaultViewsCap`) |
| `BundleItem` | كورس BUNDLE بيحتوي كورسات تانية |
| `CourseUnit` → `Lesson` | الوحدة فيها دروس؛ الدرس نوعه VIDEO/QUIZ/ASSIGNMENT + قواعد تنقيط (drip) وسقف مشاهدات |
| `VideoAsset` | الفيديو بعد المعالجة لـHLS مشفّر AES-128 (المصدر الخام مش بيتعرض أبداً) |
| `HlsEncryptionKey` | مفاتيح AES-128 للـsegments؛ بتتبدّل دورياً |
| `Attachment` | مرفقات الدرس |

**الاشتراك والتقدّم**
| Model | الغرض |
|---|---|
| `Enrollment` | `status` (PENDING_APPROVAL/ACTIVE/REJECTED/EXPIRED/REVOKED), `expiresAt` (للاشتراك الشهري), فريد لكل (student, course) |
| `LessonProgress` | موضع المشاهدة، `watchedPct`, `viewCount`, `completedAt`, `firstUnlockedAt` |
| `VideoNote`, `VideoBookmark` | ملاحظات/علامات الطالب على تايم لاين الفيديو |

**الأمان (Security suite)**
| Model | الغرض |
|---|---|
| `PlaybackSession` | صف لكل فتح للمشغّل؛ فيه `watermarkId` (المفتاح الجنائي للتتبّع) + تليمتري |
| `SecurityEvent` | أحداث أمنية (MULTI_IP_PLAYBACK, SESSION_LIMIT_KICK, LEAK_TRACED...) بدرجات خطورة |

**المدفوعات والدفتر المالي**
| Model | الغرض |
|---|---|
| `Payment` | `status` (PENDING/PAID/REJECTED/FAILED/REFUNDED), `method`, `proofImageUrl`, `reference`, `verifiedById` |
| `PaymentEvent` | حدث تحويل خام جاي من تطبيق الأندرويد؛ نتيجة المطابقة (MATCHED/UNMATCHED/AMBIGUOUS/DUPLICATE) |
| `PlatformPaymentAccount` | حسابات الاستلام (إنستاباي/فودافون/بنك) اللي الطالب يحوّل عليها |
| `LedgerTransaction` + `LedgerEntry` | **دفتر أستاذ مزدوج القيد** (double-entry): مجموع المدين = مجموع الدائن. القيود غير قابلة للتعديل |
| `Coupon` | كوبونات خصم (نسبة/مبلغ) لكل مدرّس |
| `PayoutMethodSaved`, `PayoutRequest` | طرق السحب وطلبات السحب الشهرية |
| `Invoice` | فاتورة بسيريال `DRS-INV-YYYY-NNNNNN` لكل دفعة مؤكّدة |

**اتفاقية حسابات الدفتر:**
```
platform:cash               — الكاش اللي المنصّة ماسكاه
platform:commission         — أرباح المنصّة (العمولة)
teacher:<tenantId>:balance  — رصيد المدرّس القابل للسحب
```
رصيد المدرّس = Σ(دائن) − Σ(مدين) على حساب رصيده.

**التقييم**
| Model | الغرض |
|---|---|
| `Quiz` → `QuizQuestion` / `QuizAttempt` | اختبار: درجة نجاح، وقت، `maxAttempts` (سقف المحاولات)، خلط أسئلة. الأسئلة MCQ/TRUE_FALSE/SHORT_ANSWER |
| `Assignment` → `AssignmentSubmission` | واجب: نص + ملف، تصحيح يدوي بدرجة وملاحظات |
| `Certificate` | شهادة إتمام بسيريال `DRS-CERT-YYYY-NNNNNN` (فريدة لكل student+course) |

**التواصل والاجتماعي**
| Model | الغرض |
|---|---|
| `Review` | تقييم 1–5 (فريد لكل student+tenant+course) |
| `ChatThread` → `ChatMessage` | شات مباشر (DM) أو سؤال/جواب مربوط بلحظة في الفيديو |
| `Announcement`, `Notification` | إعلانات (منصّة/مدرّس) + إشعارات لحظية بأنواع مختلفة |
| `LiveSession` → `LiveBooking` | جلسات مباشرة + حجز مقاعد (بسعة اختيارية) |

**عمليات المنصّة**
| Model | الغرض |
|---|---|
| `AuditLog` | سجل تدقيق لكل فعل حسّاس (teacher.approve, payout.complete...) |
| `PlatformSetting` | إعدادات key-value عامة للأدمن (مثال: `payout.minimumCents`) |

---

## 2) الباك إند — الموديولات والمنطق

الموديولات: `admin, analytics, assessments, audit, auth, catalog, chat, common,
courses, enrollments, health, live, notifications, payments, payouts, playback,
prisma, profile, progress, realtime, reviews, security, storage, student,
teachers, uploads, video`.

### 2.1 المصادقة (auth)
`apps/api/src/auth/*`
- **التسجيل**: طالب → `ACTIVE` فوراً مع توكنات. مدرّس → `PENDING` بدون توكنات
  لحد موافقة الأدمن.
- **الدخول**: يتحقق من القفل (lockout) قبل الباسورد، يعمل `argon2.verify` **دايماً**
  (حتى لو الإيميل مش موجود، ضد dummy hash — منع تعداد المستخدمين)، وبيصفّر عدّاد
  الفشل عند النجاح.
- **التوكنات** (`token.service.ts`): access JWT قصير + refresh JWT بـ**rotation**
  وكشف إعادة الاستخدام (لو refresh اتستخدم بعد التدوير → إلغاء الجلسة كلها).
  الـaccess بيتراجع مقابل حالة `DeviceSession` الحيّة في كل طلب.
- **نسيان/إعادة كلمة السر**: توكن عشوائي 32 بايت، بيتخزّن **hash فقط**، single-use،
  ينتهي بعد ٣٠ دقيقة. الرد دايماً "ok" (منع تعداد الإيميلات).

### 2.2 العزل بين المدرّسين (Tenancy)
كل استعلام مملوك لمدرّس بيتفلتر بـ`findFirst({ where: { id, tenantId } })`
ويرجّع **404 مش 403** (عشان ما نكشفش وجود الصف). ده مطبّق في courses, payments,
payouts, live, coupons, quizzes... إلخ.

### 2.3 الكورسات والمحتوى (courses, uploads)
- المدرّس يبني: كورس → وحدات → دروس، ويرتّبهم (reorder)، ويرفع صورة الكورس
  (data URL). الحذف = soft delete.
- **رفع الفيديو** (`uploads` + `video`): المصدر بيترفع خاص، بيتحوّل لـHLS مشفّر
  AES-128 (بـffmpeg)، والمصدر الخام **بيتمسح بعد التغليف**. الحالة UPLOADING →
  PROCESSING → READY.

### 2.4 خط أنابيب الفيديو المحمي (playback)
`apps/api/src/playback/*` — أهم جزء أمني في المحتوى:
- **قرار الوصول** (`resolveAccess`): admin/مدرّس صاحب الكورس preview؛ الطالب لازم
  اشتراك ACTIVE غير منتهي + قواعد الـdrip + سقف المشاهدات + نافذة الوصول. الدرس
  المحذوف (soft-deleted) **مش بيشتغل** (فحص `deletedAt` على الدرس والوحدة والكورس).
- **روابط موقّعة** (`SignedUrlService`): توكن HMAC قصير العمر يفتح ملفات أصل فيديو
  واحد بس، متربوط بالجلسة + المستخدم + العلامة المائية. مفيش رابط دائم.
- **مفتاح التشفير** بيتقدّم بس لجلسة حيّة غير ملغاة (double-check في الـDB).
- **العلامة المائية** (`watermarkId` مثل `DRS-89421-A8X9`): متحروقة في overlay
  متحرّك؛ leak-trace بترجّعها للجلسة/الطالب.
- **حماية الجلسة**: heartbeat/end متقيّدين بالملكية (الطالب لجلسته فقط؛ المدرّس داخل
  الـtenant بتاعه فقط).

### 2.5 الاشتراك (enrollments)
- كورس مجاني → ACTIVE فوراً (+ فتح كورسات الـBUNDLE الفرعية).
- كورس مدفوع → يرمي `PAYMENT_REQUIRED` مع الكوتيشن؛ الطالب يروح شاشة الدفع.
- `approve()`: **يرفض تفعيل كورس مدفوع من غير دفعة PENDING**، وبيعمل التفعيل + قيد
  الدفتر + الفاتورة **ذرّياً** (transaction واحدة).

### 2.6 المدفوعات + الدفتر + المطابقة التلقائية (payments)
أهم منطق مالي — 3 ملفات:

**`manual-payments.service.ts`** — الدفع اليدوي بإثبات:
1. الطالب يرفع إسكرين + طريقة + مرجع → `Payment(PENDING)` + `Enrollment(PENDING_APPROVAL)`.
2. المدرّس/الأدمن **يؤكّد**: `applyVerification` بيعمل في **transaction واحدة**:
   قلب الحالة لـPAID (بشرط `updateMany where status=PENDING` — يمنع التأكيد المزدوج) +
   تفعيل الاشتراك + **قيد الدفتر** + زيادة عدّاد الكوبون. الفاتورة والإشعار بعد
   الترانزاكشن. → **مفيش "مدفوع من غير ما المدرّس ياخد فلوسه".**
3. **الرفض**: بيقلب الدفعة REJECTED **والاشتراك** REJECTED معاها (يمنع تفعيلها لاحقاً بالغلط).

**`ledger.service.ts`** — الدفتر المزدوج:
- `recordPayment`: يقسّم الدفعة → `platform:cash` (مدين) = العمولة (دائن) + نصيب
  المدرّس (دائن). حساب صحيح بالقرش، مجموع مدين = مجموع دائن. idempotent (قيد فريد
  لكل دفعة).
- `recordPayout`: يخصم من رصيد المدرّس ويرجّع لكاش المنصّة عند إتمام السحب.
- `teacherBalance`, `teacherEarnings`, `platformTotals`: تجميعات للأرصدة.

**`payment-matching.service.ts`** — التحقق التلقائي:
- بيستقبل حدث تحويل من تطبيق الأندرويد (`ingest`) ويطابقه بدفعة PENDING على:
  **المبلغ + الطريقة + نافذة زمنية** (72 ساعة قبل / 30 دقيقة بعد)، ويميّز بينهم
  بالمرجع (**مطابقة تامة** — مش fuzzy — عشان ما يخلطش تحويلين).
- **منع التكرار**: نفس التحويل المعاد إرساله (بالمرجع، أو نفس الرسالة الخام، أو نفس
  الجهاز في نفس اللحظة) → DUPLICATE.
- عند مطابقة واحدة واثقة → `systemVerify` (نفس مسار التأكيد البشري).

### 2.7 السحب (payouts)
- طلب السحب في **transaction من نوع Serializable**: يقرأ الرصيد + المعلّق ويعمل
  الطلب كوحدة واحدة → **يمنع السحب المزدوج المتزامن** (وإلا رصيد سالب).
- الإتمام (COMPLETED): يعيد التحقق من الرصيد ويقيّد الخصم ذرّياً. الحد الأدنى من
  `PlatformSetting["payout.minimumCents"]`.

### 2.8 التقييم (assessments)
- **اختبارات**: التصحيح تلقائي لـMCQ/TF، ويدوي لـSHORT_ANSWER. **ضد الغش**: سقف
  محاولات (`maxAttempts`)، ومفتاح الإجابات مبيتكشفش إلا بعد النجاح أو انتهاء
  المحاولات (يمنع "أجاوب غلط أشوف الإجابات أعيد ١٠٠٪").
- **واجبات**: تسليم مرة واحدة، تصحيح المدرّس بدرجة وملاحظات (مقفول بعد التصحيح).
- **شهادات**: تصدر لما الطالب يكمّل كل دروس الكورس؛ سيريال فريد مع retry ضد التضارب.
  تحقّق عام بالسيريال + عرض مالك فقط.

### 2.9 الجلسات المباشرة (live)
- المدرّس ينشئ جلسة (وقت/مدة/سعة) ويعلن لطلابه. الطالب يحجز لو **مشترك ACTIVE غير
  منتهي**. السعة محمية بـ**Serializable transaction** (يمنع الحجز الزائد). رابط
  الدخول بيظهر بس للمحجوز داخل النافذة الزمنية (يفتح 15 دقيقة قبل).

### 2.10 التواصل (chat, notifications, realtime)
- **الشات** عبر Socket.io (`chat.gateway.ts`): كل اتصال متحقّق بالـJWT في
  الـhandshake. الانضمام/الإرسال/الكتابة (typing) كلها متحقّقة بـ`canAccessThread`
  (يمنع دخول ثريد شخص تاني). DM بين الطالب والمدرّس متربوط باشتراك ACTIVE.
- **الإشعارات**: أنواع (ENROLLMENT_APPROVED, CHAT_MESSAGE, QUIZ_GRADED,
  PAYOUT_STATUS, SECURITY_ALERT, LIVE_SESSION_REMINDER...) بجرس لحظي.

### 2.11 التحليلات والأدمن (analytics, admin, security, audit)
- **تحليلات المدرّس** (`/teacher/analytics`): إيراد/اشتراكات متقيّدة بالـtenant.
- **الأدمن**: نظرة عامة مالية، موافقة المدرّسين، معالجة السحب، أحداث الأمان، سجل
  التدقيق، إدارة حسابات الاستلام وأحداث الدفع.
- **security**: أحداث المدرّس، جلساته، وleak-trace بالـwatermarkId.

---

## 3) خريطة الـAPI الكاملة

كله تحت `/api/v1`. الحماية عامة: كل المسارات محميّة افتراضياً إلا المعلّمة `@Public`.

### auth `/auth`
```
POST register/student   POST register/teacher   POST login
POST forgot-password    POST reset-password     POST refresh   POST logout
GET  me                 GET  sessions           DELETE sessions/:id
```
### الكتالوج والاكتشاف
```
GET  catalog/subjects            GET catalog/grades      (+ admin POST/PATCH/DELETE)
GET  teachers                    GET teachers/:slug
GET  teacher/profile             PATCH teacher/profile
GET  courses/:id                 (عرض عام لكورس)
```
### المدرّس — بناء الكورسات `/teacher`
```
GET/POST courses     GET/PATCH/DELETE courses/:id     PATCH courses/:id/thumbnail
PATCH courses/:id/bundle
POST courses/:courseId/units     PATCH/DELETE units/:id     PATCH .../units/reorder
POST units/:unitId/lessons       PATCH/DELETE lessons/:id   PATCH .../lessons/reorder
```
### الرفع والملفات
```
POST uploads/videos              GET uploads/videos/:id/status
POST uploads/lessons/:lessonId/attachments   DELETE uploads/attachments/:id
GET  files/attachments/:id
```
### التشغيل المحمي `/playback`
```
POST sessions   POST sessions/:id/heartbeat   POST sessions/:id/event   POST sessions/:id/end
GET  hls/:token/master.m3u8     GET hls/:token/:rendition/:file     GET key/:token
GET  lessons/:lessonId/notes    POST lessons/:lessonId/notes        DELETE notes/:id
```
### الاشتراك والدفع
```
POST enrollments/quote   POST enrollments   GET enrollments/mine
GET  teacher/enrollments   PATCH teacher/enrollments/:id/{approve|reject|revoke}
GET  payment-accounts    POST payments    GET payments/mine
GET  teacher/payments    POST teacher/payments/:id/{verify|reject}
GET  admin/payments      POST admin/payments/:id/{verify|reject}
GET/POST/PATCH/DELETE admin/payment-accounts
POST payment-events (@Public, listener)   GET admin/payment-events   POST admin/payment-events/:id/match/:paymentId
```
### المحفظة والسحب
```
GET  teacher/wallet
GET/POST teacher/payouts   GET/POST teacher/payouts/methods   DELETE .../methods/:id
```
### التقييم
```
PUT  teacher/lessons/:lessonId/quiz            PUT .../quiz/questions   GET .../quiz
POST teacher/quiz-attempts/:attemptId/grade
GET  lessons/:lessonId/quiz                    POST lessons/:lessonId/quiz/attempts
PUT  teacher/lessons/:lessonId/assignment      GET .../assignment
POST teacher/assignment-submissions/:submissionId/grade
GET  lessons/:lessonId/assignment              POST .../assignment/submissions
GET  certificates/mine   GET certificates/verify/:serial   GET certificates/mine/:serial
```
### اللايف، الاجتماعي، الطالب
```
GET/POST/PATCH/DELETE teacher/live   GET teacher/live/:id/bookings
GET  live/upcoming   POST live/:id/book   DELETE live/:id/book   GET live/:id/join
GET/POST reviews   GET reviews/mine/:courseId
GET  chat/threads  GET chat/threads/:id/messages  POST chat/messages
GET  notifications   PATCH notifications/:id/read   PATCH notifications/read-all
POST/DELETE courses/:id/save   GET me/saved   GET me/badges
GET  progress/continue-watching   GET progress/summary   PATCH progress/weekly-goal
GET/PATCH me/profile   POST me/avatar   DELETE me/avatar
GET  teacher/coupons + POST/PATCH/DELETE
GET  teacher/security/{events|sessions|trace/:watermarkId}
GET  teacher/analytics
```
### الأدمن `/admin`
```
GET overview   GET teachers   PATCH teachers/:id/status
GET payouts    PATCH payouts/:id
GET security-events   GET audit-logs
```

---

## 4) الحماية — بالتفصيل حرفياً 🔒

### 4.1 الحُرّاس العامّون (Global Guards)
مرتّبين في `app.module.ts` على كل الطلبات:
1. **ThrottlerGuard** — حد معدّل عام: 120 طلب / 60 ثانية.
2. **JwtAuthGuard** — يتحقق من access JWT + يراجع حالة `DeviceSession` الحيّة
   (logout/kick بيقتل التوكن فوراً قبل انتهاء صلاحيته). المسارات `@Public` بتتخطّاه.
3. **RolesGuard** — يطبّق `@Roles(...)` (STUDENT/TEACHER/SUPER_ADMIN).

الديكوريتورز: `@Public()`, `@Roles(...)`, `@CurrentUser()`
(في `common/decorators/`). الحُرّاس في `common/guards/`.

### 4.2 كلمات السر والتوكنات
- **argon2** لكل كلمات السر و**للـrefresh tokens** (hash مش plaintext).
- **JWT**: access قصير + refresh بـrotation + كشف إعادة استخدام (سرقة refresh →
  إلغاء الجلسة كلها).
- **دخول ثابت التوقيت**: verify ضد dummy hash حتى لو المستخدم مش موجود → منع تعداد
  المستخدمين عبر فروق التوقيت.
- **قفل بعد المحاولات**: 10 محاولات فاشلة → قفل 15 دقيقة (`failedLogins/lockedUntil`).
- **إعادة كلمة السر**: SHA-256 لتوكن عشوائي 32 بايت، single-use، 30 دقيقة، والرد
  دايماً "ok".

### 4.3 فحص الإعدادات عند الإقلاع (fail-fast)
`common/config.validation.ts` بيرفض تشغيل الإنتاج لو:
- `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` ناقص/قيمة افتراضية معروفة/أقصر من 32
  بايت، أو الاتنين متساويين → **خطأ قاتل**.
- الأسرار الضعيفة بتوقف الإقلاع؛ `OTP_DEV_MODE=true` بيطلع **تحذير** بس (التسريب
  متقفل أصلاً في الكود عبر `NODE_ENV !== 'production'`).
- `VIDEO_SIGNING_SECRET` لو فاضي بيرجع لـ`JWT_ACCESS_SECRET` — **مفيش fallback ثابت
  غير آمن**.

### 4.4 العزل بين المستأجرين (Tenant isolation)
كل مورد مملوك لمدرّس بيتأكّد إنه `tenantId == user.tenantId`، ويرجّع 404 لو لأ.
مطبّق في: courses/units/lessons/video, payments (verify/reject),
payouts, coupons, live, quizzes/assignments (تصحيح), security, chat.

### 4.5 الحذف الناعم (Soft delete) الآمن
Prisma middleware واحد (`prisma.service.ts`) بيحوّل `delete → update deletedAt`
ويفلتر القراءات. **مهم**: مسارات الوصول الحسّاسة (تشغيل الفيديو، الاختبارات،
التقييمات) بتستخدم `findFirst({deletedAt:null})` + فحص الوحدة/الكورس الأب يدوياً —
عشان الدرس المحذوف ما يفضلش شغّال.

### 4.6 حماية الفيديو (DRM خفيف)
- HLS مشفّر AES-128 + مفاتيح بتتبدّل دورياً، بتتقدّم بس لجلسة حيّة موقّعة.
- روابط HMAC قصيرة العمر لأصل واحد، مع حماية من path traversal.
- علامة مائية جنائية لكل جلسة + كشف تسريب.
- سقف جلسات متزامنة لكل طالب (`maxConcurrentSessions`) + kick للأقدم.

### 4.7 حماية الفلوس
- **قيود ذرّية**: قلب حالة الدفعة + قيد الدفتر + الاشتراك في transaction واحدة.
- **حارس ضد التأكيد المزدوج**: `updateMany where status=PENDING` (قيمة العدّاد = 1).
- **السحب**: Serializable transaction + إعادة فحص الرصيد (لا سحب مزدوج، لا رصيد سالب).
- **قيد فريد** `LedgerTransaction.paymentId/payoutId` = الحارس النهائي ضد الازدواج.
- **نقطة الاستماع للدفع** (`payment-events`, `@Public`): بتتأكّد بمفتاح مشترك
  `PAYMENT_LISTENER_KEY` عبر `timingSafeEqual` (يرفض الفاضي، throttled).

### 4.8 التحقق من المدخلات
`ValidationPipe` عامة (`whitelist + forbidNonWhitelisted + transform`) على كل
الـDTOs. صور الـdata-URL بتتحقق (النوع والحجم) في `common/image.util.ts`؛ الـSVG
مرفوض (منع XSS عبر data URLs).

### 4.9 الشبكة والإقلاع
- **CORS** من `ALLOWED_ORIGINS` (مفيش wildcard مع credentials).
- **سوكِت** الـWebSocket handshake متحقّق بالـJWT.
- **الإقلاع** (`scripts/start.sh`): `migrate deploy` بإصلاح ذاتي من P3009، و**يرفض
  الإقلاع** لو الميجريشن فشلت (بدل ما يشتغل على سكيمة تالفة). بيضبط
  `NODE_ENV=production` لضمان الفحص الصارم.

---

## 5) الفرونت إند (apps/web)

React + Vite + Tailwind، RTL عربي، PWA.

### 5.1 المعمارية والتوجيه
- `main.tsx`: يركّب React Query + `LazyMotion` + Router + تسجيل الـservice worker.
- `App.tsx`: كل الصفحات **lazy-loaded** (code-splitting لكل شاشة)، ملفوفة بـ
  `<ErrorBoundary>` (يعالج فشل تحميل chunk بعد النشر) + `<Suspense>`.
  `RequireAuth` يحمي المسارات حسب الدور.

### 5.2 الصفحات (Pages) حسب الدور
**عامّة/مصادقة:** `LoginPage, RegisterPage, ForgotPasswordPage, ResetPasswordPage,
CertificateViewPage, MessagesPage, ProfilePage`.

**الطالب** (`pages/student/`): `StudentDashboardPage, DiscoveryPage,
TeacherProfilePage, CourseDetailPage, LessonRouter` (يوزّع على) `→
SecureVideoPlayerPage / QuizTakerPage / AssignmentPage`, `MyCoursesPage,
CertificatesPage, LiveSessionsPage, SavedCoursesPage`.

**المدرّس** (`pages/teacher/`): `TeacherDashboardPage, TeacherCoursesPage,
CourseBuilderPage, QuizBuilderPage, AssignmentBuilderPage, TeacherEnrollmentsPage,
TeacherPaymentsPage, TeacherLivePage, TeacherAnalyticsPage, TeacherWalletPage,
TeacherSecurityPage, TeacherCouponsPage`.

**الأدمن** (`pages/admin/`): `AdminOverviewPage, AdminTeachersPage,
AdminPaymentsPage, AdminPayoutsPage, AdminSecurityPage`.

### 5.3 المكوّنات (Components)
| المكوّن | الغرض |
|---|---|
| `Layout` | الهيكل: sidebar (brand + nav حسب الدور) + TopBar + المحتوى |
| `TopBar` | بحث + جرس إشعارات + قائمة حساب + تبديل لغة |
| `AuthShell` + `AuthField` | تخطيط شاشات الدخول (لوحة نيلي + فورم) |
| `ui.tsx` | المكوّنات المشتركة: `Badge, Stars, Spinner, Skeleton, CardGridSkeleton, PageHeader, EmptyState, Modal, Field, ProgressBar, ErrorNote` |
| `motion.tsx` | بدائل الحركة: `Reveal, Stagger, StaggerItem, hoverLift` |
| `PaymentModal` | نافذة الدفع (رفع إثبات + حسابات الاستلام) |
| `ReviewModal` | نافذة التقييم |
| `RovingWatermark` | العلامة المائية المتحركة فوق الفيديو |
| `SaveHeart` | زر الحفظ (wishlist) |
| `ErrorBoundary` | يعالج فشل تحميل chunk (reload مرة واحدة) بدل الشاشة البيضا |

### 5.4 المكتبات المساعدة (lib) والحالة
- `api.ts` — Axios instance + refresh flow (single-flight).
- `socket.ts` + `useRealtime.ts` — Socket.io (جرس + شات لحظي).
- `player-hardening.ts` — تعطيلات حماية المشغّل. `image.ts` — تصغير الصور client-side
  (مع سقف حجم). `format.ts` — تنسيق العملة/التاريخ. `authError.ts` — رسائل أخطاء الدخول.
- **الحالة**: `stores/auth.ts` (Zustand + persist للتوكنات والمستخدم).
- **الأنواع المشتركة**: `packages/shared-types` (Role, enums, DTOs, `RealtimeEvents`،
  `JwtPayload`، `Paginated`، ...).

### 5.5 نظام الديزاين (Design tokens) — "Ink & Paper"
مضبوط في `tailwind.config.ts` + `index.css`:
- **لون واحد (accent)**: نيلي iris `#4A32C9` (سكيل 50–900). مفيش تركوازي/جراديينت.
- **حيادي دافئ**: ورق `#F7F7F4` / حبر `#1B1B22` (مش أبيض/أسود صافي)؛ الحدود حبر
  بشفافية 8–10% (hairlines).
- **الخطوط**: عناوين **Rubik** + نص **IBM Plex Sans Arabic** (عربية أصيلة، مش
  Tajawal/Inter الافتراضية). مقياس عناوين مرن `clamp()` وتباعد حروف سالب.
- **راديوس واحد 12px** لكل حاجة؛ `rounded-full` للـpills/الأڤاتار فقط.
- **الظلال**: حدود 1px هي الفصل الأساسي؛ ظلّين بس للمودالات/القوائم المنبثقة.
- **grain**: طبقة نويز SVG خفيفة (~3.5%) تكسر الإحساس المسطّح.
- **الحركة**: Framer Motion — fade + رفعة صغيرة، `easeOutExpo`، مرة واحدة عند
  الظهور، transform/opacity فقط، وتحترم `prefers-reduced-motion`.

### 5.6 PWA
`manifest.webmanifest` + أيقونات PNG (192/512 + apple-touch) + service worker
(`sw.js`) بكاش **مرتبط برقم البناء** (كل نشر يمسح الكاش القديم)، والـHTML fallback
للتنقّل فقط (مش للأصول — يمنع أعطال). التسجيل في الإنتاج فقط.

---

## 6) الأداء (Performance)

- **Code-splitting** لكل صفحة (route-level `React.lazy`).
- **تقسيم الـvendors** (`vite.config.ts manualChunks`): react / framer-motion /
  data / realtime / i18n في شانكات منفصلة تتحمّل بالتوازي وتتكاش عبر الزيارات.
  الـapp shell ≈ **28KB gzip** فقط.
- **LazyMotion** (m API): مجموعة حركة الـDOM في شانك معزول (~24KB gzip) بدل تضخيم
  الـshell.
- **hls.js** بيتحمّل بس في دروس الفيديو (شانك منفصل ~167KB gzip).
- الصور: تصغير client-side + `loading="lazy"`. الخطوط: `display=swap`.

**أحجام الحزمة (gzip):** shell ~28 · react ~51 · data ~33 · motion ~24 · i18n ~16 ·
realtime ~13 · CSS ~8.

---

## 7) التشغيل والنشر (مختصر)

```bash
cp .env.example .env && cp .env.example apps/api/.env
docker compose up -d postgres        # Postgres على 5434
npm install
npm run db:migrate && npm run db:seed
npm run dev:api                       # http://localhost:4000  (Swagger: /api/docs)
npm run dev:web                       # http://localhost:5173
```
**حسابات الديمو:** أدمن `admin@darsly.app / Admin@12345`،
مدرّس `khaled@darsly.app / Teacher@12345`، طالب `ahmed@student.darsly.app / Student@12345`.

النشر على Railway + متغيّرات البيئة + حلّ P3009 + تثبيت الموبايل: كله في
[`DEPLOYMENT.md`](./DEPLOYMENT.md). تطبيق استقبال الدفع: [`android-payment-listener.md`](./android-payment-listener.md).

---

## 8) خرائط سريعة (فين ألاقي إيه)

| عايز | الملف |
|---|---|
| نموذج البيانات كامل | `apps/api/prisma/schema.prisma` |
| المصادقة | `apps/api/src/auth/*` |
| الدفع اليدوي + التحقق التلقائي | `apps/api/src/payments/{manual-payments,payment-matching,payment-events}.*` |
| الدفتر المالي | `apps/api/src/payments/ledger.service.ts` |
| السحب | `apps/api/src/payouts/payouts.service.ts` |
| الفيديو المحمي | `apps/api/src/{playback,video,uploads}/*` |
| الحذف الناعم (middleware) | `apps/api/src/prisma/prisma.service.ts` |
| فحص الإعدادات | `apps/api/src/common/config.validation.ts` |
| الحُرّاس/الديكوريتورز | `apps/api/src/common/{guards,decorators}/*` |
| توكنز الديزاين | `apps/web/tailwind.config.ts` + `apps/web/src/index.css` |
| بدائل الحركة | `apps/web/src/components/motion.tsx` |
| توجيه الصفحات | `apps/web/src/App.tsx` |
