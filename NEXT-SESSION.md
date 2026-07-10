# حالة المشروع — نقطة البداية للمرة الجاية

آخر كوميت: `8031f73` (Frontend polish part 2) — مدفوع على `main`.

## ✅ اللي خلص
- **Phase 1**: auth (OTP+password، JWT rotation، device sessions)، RBAC، seed.
- **Phase 2**: كتالوج، دورات CRUD، وحدات/دروس، التحاق (quote→approve/reject/revoke)، كوبونات، اكتشاف + ملف معلم عام. شاشات React كاملة.
- **Phase 3**: فيديو مشفّر (ffmpeg→AES-128 HLS)، روابط موقّعة + مفتاح مُبوّب بالجلسة، DRM adapter (native + stubs)، تخزين مجرّد (local/s3)، تحكم جلسات/أجهزة، كشف multi-IP/rapid-seek، مشغّل بعلامة مائية متحركة + تقسية. متحقق منه (15 unit + 21 smoke + متصفح حقيقي فكّ التشفير).
- **تحسين الفرونت (جزء 1+2)**: شريط علوي زجاجي (بحث + جرس إشعارات حقيقي + قائمة مستخدم)، Layout جديد بسايدبار محسّن، primitives (أزرار/skeletons/glass)، إشعارات API، وكل الشاشات اتظبطت على `PageHeader` + skeletons. تنظيف بيانات الـ smoke + سكريبتات تنظّف بعد نفسها.

## 🔜 المهام الكبيرة المتبقية (محتاجة موافقتك للبدء)

### أ. فيديو الإنتاج على Railway (مش شغّال لايف لسه)
النشر بيقلع سليم بس معالجة الفيديو محتاجة:
1. **ffmpeg في صورة البناء** — Railway Railpack مفيهوش ffmpeg. الحل: Dockerfile أو إضافة الحزمة.
2. **تخزين S3** — قرص Railway مؤقت؛ ملفات HLS بتضيع مع كل deploy. المُحوّل جاهز، محتاج bucket + مفاتيح + `STORAGE_DRIVER=s3`.

### ب. Phase 4 — الشات والتواصل
- شات لحظي (Socket.io) طالب↔معلم، Q&A مربوط بلحظة في الفيديو.
- إشعارات لحظية (فوق الـ API الموجود).
- تتبّع تقدّم الطالب، streaks، أهداف أسبوعية، لمسات راحة الطالب.

### ج. باقي المراحل
- **Phase 5**: دفتر الدفع (ledger)، السحب (payouts)، لوحات الأدمن، تبويب أمان المعلم (Leak-Trace UI).
- **Phase 6**: اختبارات، تقييمات، شهادات، تلميع نهائي.

## ⚠️ تنبيهات
- `OTP_DEV_MODE=true` على الإنتاج — أي كود `0000` يدخل. **لازم يتقفل قبل أي إطلاق حقيقي.**
- شاشة الأدمن لسه مش متعملة (SUPER_ADMIN بيدخل بس مفيش لوحة مخصصة له — بتيجي في Phase 5).

## معلومات سريعة
- حسابات: طالب `01011111111` كود `0000` · معلم `khaled@darsly.app`/`Teacher@12345` · أدمن `admin@darsly.app`/`Admin@12345`.
- محلي: API `:4000` (Swagger `/api/docs`) · Web `:5173` · Postgres `5434`.
- لايف: https://darslyapi-production.up.railway.app
- سمووك: `bash scripts/smoke-auth.sh` (18) · `smoke-phase2.sh` (37، بينظّف نفسه) · `smoke-phase3.sh` (21، محتاج ffmpeg + `scratchpad/sample.mp4`).
- المرجع البصري: `/home/ahmedeldeeb/Pictures/stitch_hessa_edtech_platform_ui/` (استبدل "حصة/Hessa" بـ "درسلي").
