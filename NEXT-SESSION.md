# حالة المشروع — نقطة البداية للمرة الجاية

**كل المراحل 1 → 6 خلصت، متحقق منها، ومدفوعة لايف على Railway ✓**

## ✅ اللي خلص واتنشر لايف
- **Phase 1**: auth (OTP+password، JWT rotation، device sessions)، RBAC، seed.
- **Phase 2**: كتالوج، دورات CRUD، التحاق، كوبونات، اكتشاف + ملف معلم. كل الشاشات.
- **Phase 3**: فيديو مشفّر (ffmpeg→AES-128 HLS)، روابط موقّعة + مفتاح مُبوّب، DRM adapter، تخزين مجرّد، تحكم جلسات، كشف multi-IP/rapid-seek، مشغّل بعلامة مائية. شغّال على الإنتاج.
- **Phase 4**: شات لحظي (Socket.io)، إشعارات مركزية، تتبّع تقدّم (continue-watching + streaks).
- **Phase 5**: دفتر double-entry، محفظة + فواتير، سحب (معلم+أدمن)، لوحة أدمن، تبويب أمان + Leak-Trace.
- **Phase 6**: اختبارات (اختيار من متعدد/صح-خطأ/مقالي، تصحيح تلقائي + يدوي)، واجبات (تسليم + تصحيح)، تقييمات دورات، شهادات إتمام (سيريال DRS-CERT + تحقق عام + صفحة قابلة للطباعة).

## Phase 6 — التفاصيل التقنية
- باك إند: `assessments` module (@Global، بيصدّر CertificatesService) + `reviews` module.
  - `QuizzesService`: تأليف المعلم (upsert quiz + set questions bulk)، تأدية الطالب (إجابات مخفية)، تصحيح تلقائي للـ MCQ/TF فوراً، والمقالي يروح `needsManualGrading`، والمعلم يعتمد الدرجة النهائية → إشعار `QUIZ_GRADED`.
  - `AssignmentsService`: upsert واجب، تسليم الطالب (نص)، تصحيح المعلم (درجة/ملاحظات، حارس الحد الأقصى).
  - `CertificatesService`: يُصدر شهادة أول ما يكمل الطالب **كل** دروس الدورة (idempotent، سيريال متسلسل)، مربوط بالـ playback heartbeat + نجاح الاختبار/تسليم الواجب. تحقق عام `/certificates/verify/:serial`.
  - `LessonAccessService`: بوابة مشتركة (enrollment + drip) بتحاكي قواعد المشغّل.
- فرونت: `QuizBuilderPage` / `AssignmentBuilderPage` (معلم، مربوطين من CourseBuilder)، `LessonRouter` بيوزّع الدرس حسب نوعه، `QuizTakerPage` (نتيجة + مراجعة إجابات)، `AssignmentPage`، `CertificatesPage` + `CertificateViewPage` (قابلة للطباعة/المشاركة)، `ReviewModal` في صفحة الدورة. nav + i18n (ar/en).
- تحقق: `smoke-phase6.sh` (20/20)، 8 اختبارات وحدة جديدة (grading + certificate issuance/idempotency)، متصفح حقيقي، والبناء الكامل أخضر.

## 🔐 تحديث الـauth (بعد Phase 6)
- **الكل بيدخل بإيميل + باسورد** (شيلنا موبايل/OTP نهائياً). argon2 + rate-limit + قفل بعد ١٠ محاولات + forgot/reset (توكن hashed single-use).
- **الطالب** يسجّل ويدخل فوراً؛ **المعلم** يسجّل → PENDING لحد ما الأدمن يوافق (دخوله مرفوض بـ `ACCOUNT_PENDING_APPROVAL`).
- شاشات جديدة: Login/Register (توجّل طالب/معلم)/Forgot/Reset بتصميم split-screen محترم.
- seed مليان داتا للعرض: اختبار+واجب مصحّحين، شهادة لأحمد، ٦ التحاقات (٢ بانتظار موافقة)، محادثات شات، إشعارات، تقدّم+streak.
- تحقق: `smoke-auth.sh` (24/24)، `smoke-phase6.sh` (20/20)، ٢٧ اختبار وحدة، متصفح حقيقي.

## ⚠ قبل الإطلاق الحقيقي (متبقّي عام)
- بوابة الدفع لسه mock — تحتاج تكامل حقيقي (Paymob/Fawry).
- forgot-password يحتاج SMTP حقيقي (حالياً بيرجّع التوكن في dev فقط عبر `OTP_DEV_MODE`).
- رفع ملفات الواجبات: التسليم حالياً نصّي فقط.
- تلميع/overhaul شامل لباقي الواجهة مؤجَّل ([[frontend-polish-deferred]]).

## ملاحظات مرجعية
- Postgres على **5434**. حسابات seeded في README.
- Railway: single-service، auto-deploy على push للـ main.
