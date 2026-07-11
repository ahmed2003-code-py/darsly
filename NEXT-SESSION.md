# حالة المشروع — نقطة البداية للمرة الجاية

آخر كوميت على `main`: `9cf3c34` (Phase 4) — **مدفوع ومنشور لايف على Railway ✓**.

## ✅ اللي خلص واتنشر لايف
- **Phase 1**: auth (OTP+password، JWT rotation، device sessions)، RBAC، seed.
- **Phase 2**: كتالوج، دورات CRUD، التحاق، كوبونات، اكتشاف + ملف معلم. كل الشاشات.
- **Phase 3**: فيديو مشفّر (ffmpeg→AES-128 HLS)، روابط موقّعة + مفتاح مُبوّب، DRM adapter، تخزين مجرّد، تحكم جلسات، كشف multi-IP/rapid-seek، مشغّل بعلامة مائية. **شغّال على الإنتاج** (Dockerfile+ffmpeg، قرص دائم `/data`).
- **تحسين الفرونت (جزء 1+2)**: شريط علوي زجاجي، سايدبار، primitives، skeletons، إشعارات.
- **Phase 4**: 
  - شات لحظي (Socket.io gateway بـ JWT، غرف user/thread، typing).
  - إشعارات لحظية مركزية (`NotificationsService.create` بيكتب + يبعت socket).
  - progress: continue-watching، ملخص أسبوعي، streaks (بتتحدّث من الـ heartbeat).
  - فرونت: لوحة الطالب (متابعة المشاهدة + حلقة التقدم + streak)، صفحة الرسائل (قائمة محادثات + محادثة لحظية + typing)، سؤال المعلم من المشغّل (Q&A مربوط باللحظة)، nav محدّث.
  - متحقق: `smoke-phase4.sh` (13/13)، اختبار socket لحظي، ومتصفح حقيقي (رسالة وصلت لحظياً + جرس مباشر).

## 🎯 التالي: Phase 5 — الدفع/السحب + لوحات الأدمن + أمان المعلم

الاسكيمـا كلها جاهزة (Payment, LedgerTransaction, LedgerEntry, PayoutRequest, PayoutMethodSaved, Invoice, SecurityEvent, PlaybackSession, AuditLog) — **مفيش migration churn متوقع**.

### أ. دفتر الأستاذ (double-entry ledger)
- خدمة `LedgerService.record(payment)` تنشئ `LedgerTransaction` متوازنة عند تأكيد الدفع:
  - مثال شراء بـ 45000 قرش، عمولة 20%:
    - DEBIT `platform:cash` 45000
    - CREDIT `platform:commission` 9000
    - CREDIT `teacher:<tenantId>:balance` 36000
  - كل القيم أعداد صحيحة (قروش)، والتصحيحات معاملات ADJUSTMENT جديدة (immutable).
- اربطها في `EnrollmentsService` عند تحويل Payment→PAID (approve/auto-approve). حالياً بيتعمل Payment بس من غير ledger.
- endpoint: `GET /teacher/wallet` (الرصيد القابل للسحب = مجموع قيود `teacher:<tenantId>:balance`).
- فاتورة: توليد `Invoice` بسيريال `DRS-INV-YYYY-NNNNNN` عند الدفع (PDF لاحقاً أو JSON الآن).

### ب. السحب (payouts)
- `POST /teacher/payouts` (يطلب سحب؛ يتحقق من `payout.minimumCents`=50000 والرصيد)، `GET /teacher/payouts`, `GET/PATCH /teacher/payout-methods`.
- أدمن: `GET /admin/payouts`, `PATCH /admin/payouts/:id` (approve/processing/complete/reject) — عند COMPLETED ينشئ قيد ledger (DEBIT teacher:balance, CREDIT platform:cash) + إشعار.

### ج. لوحات الأدمن (SUPER_ADMIN)
- شاشة `/admin` (لسه مفيش أي شاشة أدمن): نظرة عامة (إجمالي الطلاب/المعلمين/الدورات/الإيراد/العمولة)، اعتماد المعلمين (`PATCH /admin/teachers/:id/status` PENDING→APPROVED)، طلبات السحب، سجل الأمان، سجل التدقيق (AuditLog).
- الاسكيمـا: `TeacherProfile.status` PENDING موجود؛ seed فيه معلم pending للاختبار.

### د. تبويب أمان المعلم + Leak-Trace
- `GET /teacher/security/events` (SecurityEvent مصفّاة بالـ tenant)، `GET /teacher/security/sessions` (PlaybackSession النشطة).
- **Leak-Trace**: `GET /teacher/security/trace/:watermarkId` → يرجّع الطالب+الجلسة+IP/الوقت من `PlaybackSession.watermarkId` (المفتاح الجنائي). يكتب SecurityEvent `LEAK_TRACED`.
- شاشة أمان المعلم (المرجع: `security_anti_leak_desktop`): تنبيهات الجلسات المشبوهة + أداة إدخال watermark ID.

### ترتيب مقترح
1. LedgerService + ربطه بالدفع + wallet endpoint + اختبار توازن القيود.
2. Payouts (teacher + admin) + ledger عند الإكمال.
3. Admin API + شاشة `/admin` (اعتماد معلمين، سحب، إحصائيات).
4. Teacher security tab + Leak-Trace.
5. `smoke-phase5.sh` + تحقق متصفح + build + commit + push.

## ⚠️ تنبيهات
- `OTP_DEV_MODE=true` على الإنتاج — أي كود `0000` يدخل. **يتقفل قبل أي إطلاق حقيقي.**
- الدفع لسه mock (مفيش بوابة حقيقية) — Phase 5 بيبني الـ ledger فوق الـ mock؛ البوابة الحقيقية (Paymob/Fawry) بند منفصل.

## معلومات سريعة
- حسابات: طالب `01011111111` كود `0000` · معلم `khaled@darsly.app`/`Teacher@12345` · أدمن `admin@darsly.app`/`Admin@12345` · معلم pending `pending@darsly.app`/`Teacher@12345`.
- محلي: API `:4000` (Swagger `/api/docs`) · Web `:5173` · Postgres `5434`. لايف: https://darslyapi-production.up.railway.app
- سمووك: auth(18) · phase2(37) · phase3(21, محتاج ffmpeg+sample.mp4) · phase4(13).
- Railway: بيعمل auto-deploy على أي push (`railway.json` watchPatterns **, builder Dockerfile). قرص دائم على `/data`.
- المرجع البصري: `/home/ahmedeldeeb/Pictures/stitch_hessa_edtech_platform_ui/` (استبدل "حصة/Hessa" بـ "درسلي"). لوحات Phase 5 المرجعية: `admin_overview_desktop`, `admin_financials_desktop`, `wallet_payouts_desktop`, `teacher_approvals_desktop`, `security_anti_leak_desktop`.
