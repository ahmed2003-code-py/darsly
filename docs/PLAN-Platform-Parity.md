# خطة تنفيذ: درسلي = أشمل منصة (Dr Joseph + EdNuva → Darsly)

> خريطة البناء الرسمية. كل فيتشر من الموقعين متحطّة هنا مقسّمة Phases، كل واحدة فيها: الموديلات (Prisma) + الـ endpoints + الـ UI + إعادة استخدام البنية الموجودة.
> **مبادئ حاكمة (طلب المستخدم):** (1) شكل **بروفيشنال** يحافظ على design system الموجود (Material-3 tokens). (2) **سهولة وصول** — الطالب للحصة، المدرس للستوديو، بأقل عدد نقرات. (3) نمشي **بالترتيب**، فيتشر كامل ومصقول قبل اللي بعده.
> الحالة: 🔜 لسه · 🚧 شغال · ✅ خلص. تاريخ البدء: 2026-08-29.

## القواعد الهندسية (نلتزم بيها في كل Phase)
- **Multi-tenant**: كل موديل مالي/محتوى يحمل `tenantId` (= `academyId`)، ويتفلتر بيه دايماً.
- **الفلوس = ledger مزدوج القيد**: أي رصيد يتحرّك عبر `LedgerTransaction`/`LedgerEntry` (مفيش أرقام رصيد نكتبها مباشرة).
- **الصلاحيات**: `@AcademyStaff('perm')` للمدرس/الطاقم، `@Roles(Role.X)` للطالب/الأدمن.
- **UI**: نعيد استخدام `ui.tsx` (PageHeader/Card/Badge/Modal/Field/EmptyState/Skeleton) + `Reveal` + i18n (ar+en) + RTL.
- **كل Phase**: migration + typecheck (`check:web`) + تشغيل موضعي قبل ما نقول خلصت.

---

## Phase 0 — القشرة الاحترافية وسهولة الوصول (الأساس)
> يخدم مبدأ «شكل بروفيشنال + سهولة وصول» مباشرةً، ويجهّز الـ IA اللي هنعلّق عليها كل الفيتشرز.
- **داشبورد طالب جديد** (زي EdNuva بس أنضف): كروت إحصائية (رصيد، حصصي، مدرسيني، الكود بتاعي) + «كمّل مذاكرتك» (آخر حصة) + «هيخلص قريب» + وصول سريع.
- **داشبورد مدرس**: وصول سريع للستوديو + آخر المبيعات + الطلبة + تنبيهات.
- **نـاف موسّعة بالأقسام** (Groups): تعليم / تقييم / سنتر / محفظة — بدل قائمة مسطّحة.
- **دارك مود toggle للطالب/المدرس** (الـ tokens موجودة، محتاج زرار في TopBar).
- **زر «ابدأ الحصة» / «افتح الستوديو» بارز** (سهولة وصول).
- ملفات: `Layout.tsx`, `TopBar.tsx`, `StudentDashboardPage.tsx`, `TeacherDashboardPage.tsx`, `theme.ts`.

## Phase 1 — محفظة الطالب (تُشحن بالليسنر الموجود) 🔴
> **قرار منتج (2026-08-29):** المحفظة تفصل «دخول الفلوس» عن «الشراء». تحويل واحد بالليسنر → شحن المحفظة → مشتريات لحظية (حصة-بحصة كمان). بتعيد استخدام الـ SMS-listener الموجود — **مفيش تكامل دفع جديد**. أحسن من الدفع-المباشر-لكل-حصة (اللي بيعمل تحويل منفصل كل مرة).
> **كروت الشحن الفيزيائية: مؤجّلة** (Phase 1b اختياري) — لوجيستيك يستاهل بس لو المدرس عنده سنتر/نقطة بيع. مش دلوقتي.
- **Prisma**: `StudentWallet {studentId, tenantId, balanceCents}` · `WalletTransaction {walletId, kind: TOPUP|PURCHASE|REFUND|ADJUST, amountCents, ref, paymentId?}`.
- **API**: `GET /wallet` (طالب: رصيد+سجل) · شحن عبر تدفق الدفع الموجود (`PaymentEvent` مطابَق → credit للمحفظة بدل/مع تفعيل كورس) · شراء من الرصيد.
- **Ledger**: الشحن = `platform:cash → student:<id>:wallet`؛ الشراء = خصم `student:<id>:wallet` + credit `teacher:<tenant>:balance` (نفس invariants الدفع الحالي).
- **UI طالب**: صفحة «محفظتي» (رصيد + زر اشحن يفتح تعليمات التحويل الموجودة + سجل). **`PaymentMethod.WALLET`** كوسيلة في `PaymentModal` (شراء لحظي لو الرصيد يكفي).
- **يفتح لاحقاً**: شراء على مستوى الحصة (Payment/Enrollment يقبل `lessonId`) — Phase 7.

### Phase 1b (اختياري لاحق) — كروت شحن فيزيائية
- فقط لو قررنا ندعم مدرسي السنتر. `RechargeCard {code, valueCents, batchId, status, redeemedBy}` + `POST /wallet/redeem {code}` + توليد دفعات للأدمن + تصدير. الـ Ledger نفسه.

## Phase 2 — بوابة ولي الأمر 🔴
- **Prisma**: `Role.PARENT` · `ParentProfile` · `ParentLink {parentId, studentId, relation, status}` (ربط بكود الطالب).
- **API**: `POST /parent/link {studentCode}` · `GET /parent/children` · `GET /parent/child/:id/overview` (درجات+حضور+مدفوعات+حصص) — read-only.
- **UI**: بوابة ولي أمر مبسّطة (داشبورد أطفال + تقرير لكل ابن). دخول منفصل «دخول ولي الأمر».
- **يعتمد على**: كود الطالب (Phase 5) + الدرجات الخارجية (Phase 4).

## Phase 3 — حقول تسجيل غنية + تسجيل طلاب السنتر 🔴
- **Prisma**: توسيع `StudentProfile` (governorate, area, school, schoolType[عربي/أزهر/IG/American], section/شعبة, parentPhoneFather, parentPhoneMother) · `Governorate`/`Area` lookup.
- **API**: توسيع `RegisterStudentDto` + `POST /teacher/students/manual` (المدرس بيسجّل طالب سنتر، يولّد كود + باسورد مؤقت).
- **UI**: تسجيل متعدد الخطوات (مش 13 خانة مرة واحدة — درس من دكتور جوزيف) + شاشة «سجّل طالب سنتر» عند المدرس.

## Phase 4 — نظام الدرجات «الخارجية» (سنتر) 🔴
> أوضح تميّز عند EdNuva: درجات الورق مع الأونلاين في مكان واحد.
- **Prisma**: `OfflineAssessment {tenantId, type: QUIZ|EXAM|HOMEWORK, title, maxScore, date, gradeId?}` · `OfflineGrade {assessmentId, studentId, score, note}`.
- **API**: (مدرس) CRUD تقييم خارجي + إدخال درجات (فردي/جماعي/CSV) · (طالب) `GET /my/offline-grades`.
- **UI مدرس**: جدول إدخال درجات سريع. **UI طالب**: «نتائجي» موحّدة (أونلاين+أوفلاين). يظهر لولي الأمر.

## Phase 5 — كود الطالب + حضور QR للسنتر 🟡
- **Prisma**: `StudentProfile.studentCode` (6 أرقام فريدة) · `AttendanceSession {tenantId, title, date, groupId?}` · `AttendanceRecord {sessionId, studentId, checkedInAt, method}`.
- **API**: (مدرس) فتح جلسة حضور + `POST /attendance/scan {studentCode|qr}` · (طالب) `GET /my/qr` (كود QR بيعرض studentCode موقّع).
- **UI**: شاشة مسح QR عند المدرس (كاميرا) + كود QR في داشبورد الطالب.

## Phase 6 — بنك الأسئلة 🟡
- **Prisma**: `QuestionBank {tenantId, subjectId?}` · فك `QuizQuestion` ليكون قابل لإعادة الاستخدام (`bankId?`) · `QuizQuestionLink`.
- **API**: CRUD بنك + «اسحب من البنك» عند بناء الاختبار.
- **UI**: مكتبة أسئلة + بناء اختبار بالسحب من البنك. يخدم الأونلاين والخارجي.

## Phase 7 — تقسيم المحاضرة Parts + صلاحية زمنية 🟡
- **Prisma**: `LessonPart {lessonId, title, videoAssetId, order, viewsCap?, isBasic}` · surface لـ `accessWindowDays` (موجود).
- **API/UI**: بناء أجزاء المحاضرة عند المدرس + عرض Parts عند الطالب + تنبيه «هتخلص صلاحيتها قريب» في الداشبورد.

## Phase 8 — الجداول + جدول المذاكرة + المجموعات 🟡
- **Prisma**: `StudyGroup {tenantId, name, gradeId}` · `GroupSchedule {groupId, weekday, time, place}` · `StudyPlan {studentId|groupId, items[]}`.
- **API/UI**: (مدرس) إدارة مجموعات + مواعيد + خطة مذاكرة · (طالب) «جدولي» + «جدول المذاكرة».

## Phase 9 — تواصل: تذاكر دعم + مجتمعات + إنذارات 🟢
- **تذاكر «اسأل مدرسك»**: نبني فوق `ChatThread` (نوع `SUPPORT`) + حالة (مفتوح/مغلق).
- **مجتمعات**: `Community {tenantId, gradeId?}` · `CommunityPost`/`Comment` (اختياري MVP: إعلانات فقط).
- **إنذارات تأديبية**: `StudentWarning {studentId, reason, severity}` يشوفها ولي الأمر + نوع `Notification` جديد.

## Phase 10 — تجارة موسّعة: باقات تعرض للطالب + اشتراك المدرس 🟢
- تفعيل عرض `BUNDLE` (موجود) في واجهة الطالب كـ «الباقات» + نموذج «اشترك مع المدرس» (وصول لكل كورساته).

## Phase 11 — نمو: Analytics + SEO + سرعة 🟢 (سهل، عائد عالي)
- Meta Pixel + GA4 + Microsoft Clarity في `index.html`.
- Meta description + OG tags على الستورفرونت + `lang/dir` سليمة.
- ضغط صور + lazy + skeletons (درسلي أصلاً SPA مقسّم chunks — ميزة).

## Phase 12 — قرار استراتيجي (مش سباق فيتشرز)
- **ملازم مطبوعة + حجز مقاعد سنتر فيزيائية**: لوجيستيك (شحن/مخزون/مقاعد). نقرره لما نخلص الأساس.

---

## ترتيب التنفيذ المقترح
`Phase 0 (قشرة)` → `1 محفظة` → `3 تسجيل` → `5 كود+حضور` → `2 ولي أمر` → `4 درجات خارجية` → `6 بنك أسئلة` → `7 Parts` → `8 جداول` → `9 تواصل` → `10 تجارة` → `11 نمو`.
> السبب: القشرة الأول (بروفيشنال + وصول)، وبعدين الأساسات اللي بيعتمد عليها غيرها (كود الطالب قبل ولي الأمر والحضور؛ التسجيل قبل السنتر).

## تتبّع التقدّم
| Phase | الفيتشر | الحالة |
|---|---|---|
| 0 | قشرة احترافية + وصول + دارك مود | 🔜 |
| 1.1 | محفظة طالب: رصيد + شحن بإثبات + سجل + صفحة طالب + مراجعة أدمن | ✅ اتكتب، API+web بيكومبايلوا (لسه migration) |
| 1.2 | الشراء من رصيد المحفظة (خروج فلوس) | 🔜 |
| 1.3 | شحن تلقائي بمطابقة الليسنر | 🔜 |
| 1b | كروت شحن فيزيائية (اختياري) | ⏸️ مؤجّل |
| 2 | بوابة ولي الأمر | 🔜 |
| 3 | تسجيل غني + طلاب سنتر | 🔜 |
| 4 | درجات خارجية | 🔜 |
| 5 | كود طالب + حضور QR | 🔜 |
| 6 | بنك أسئلة | 🔜 |
| 7 | Parts + صلاحية | 🔜 |
| 8 | جداول + مذاكرة | 🔜 |
| 9 | تذاكر + مجتمعات + إنذارات | 🔜 |
| 10 | باقات + اشتراك مدرس | 🔜 |
| 11 | Analytics + SEO + سرعة | 🔜 |
| 12 | ملازم + حجز سنتر (قرار) | 🔜 |
