# درسلي — دليل النشر والتشغيل الكامل (Operator Guide)

كل اللي محتاجه عشان تشغّل المشروع محلياً، تنشره على Railway، تخلّيه قابل
للتثبيت على الموبايل، وتحلّ مشكلة الـmigration الحالية — بحيث الدنيا تبقى مستقرة ١٠٠٪.

---

## 0) المشروع في سطور

**درسلي** منصة دروس عربية (RTL, EGP) لأكثر من مدرّس:
- **حساب واحد لكل الأدوار** بإيميل + باسورد (طالب / معلم / أدمن). الطالب يسجّل ويدخل فوراً؛ المعلم قيد موافقة الأدمن.
- **دورات/حصص** بدفع لمرة أو اشتراك شهري، دروس فيديو محمية (HLS مشفّر + علامة مائية)، اختبارات وواجبات، شهادات إتمام، تقييمات.
- **دفع يدوي بإثبات**: الطالب يحوّل على حسابات المنصة (إنستاباي/فودافون كاش/بنك)، يرفع إسكرين، والمدرس/الأدمن يؤكّد → أو **تحقّق تلقائي** عبر Android Notification Listener.
- **جلسات مباشرة + حجز**، **تحليلات للمعلم**، **محفظة + سحب شهري** (دفتر أستاذ double-entry)، **قائمة حفظ + شارات إنجازات** للطالب، شات لحظي وإشعارات.

**التقنية:** Monorepo — `apps/api` (NestJS + Prisma/PostgreSQL + Socket.io)، `apps/web`
(React + Vite + Tailwind، RTL, PWA)، `packages/shared-types`.

---

## 1) تشغيل محلي (Local)

```bash
cp .env.example .env && cp .env.example apps/api/.env
docker compose up -d postgres            # Postgres على 5434
npm install
npm run db:migrate                       # prisma migrate dev
npm run db:seed                          # أدمن + مدرسين + طلاب + بيانات ديمو
npm run dev:api                          # http://localhost:4000  (Swagger: /api/docs)
npm run dev:web                          # http://localhost:5173
```

**حسابات الديمو** (كلها إيميل + باسورد):

| الدور | الدخول | الباسورد |
|---|---|---|
| أدمن | `admin@darsly.app` | `Admin@12345` |
| معلم (رياضيات) | `khaled@darsly.app` | `Teacher@12345` |
| معلم (كيمياء) | `noura@darsly.app` | `Teacher@12345` |
| طالب | `ahmed@student.darsly.app` (+ sara/omar/mona/youssef) | `Student@12345` |

---

## 2) متغيّرات البيئة (Environment variables)

لازم تتظبط على Railway (وفي `.env` محلياً). النجمة (⭐) = إجباري للإنتاج.

| المتغيّر | الوصف |
|---|---|
| ⭐ `DATABASE_URL` | على Railway: `${{Postgres.DATABASE_URL}}` |
| ⭐ `JWT_ACCESS_SECRET` | سر عشوائي طويل (≥32 حرف) |
| ⭐ `JWT_REFRESH_SECRET` | سر عشوائي طويل مختلف |
| `JWT_ACCESS_TTL` | مثال `900s` (١٥ دقيقة) |
| `JWT_REFRESH_TTL` | مثال `30d` |
| ⭐ `ALLOWED_ORIGINS` | الدومين العام، مثال `https://darsly.up.railway.app` |
| ⭐ `PAYMENT_LISTENER_KEY` | سر مشترك للـAndroid listener (لو فاضي، الـ endpoint بيرفض) |
| `MAX_CONCURRENT_SESSIONS_DEFAULT` | مثال `3` |
| `STORAGE_DRIVER` | `local` (افتراضي) أو `s3` |
| `STORAGE_LOCAL_PATH` | `/data/storage` (قرص Railway الدائم) |
| `HLS_KEY_ROTATION_SECONDS`, `SIGNED_URL_TTL_SECONDS` | إعدادات الفيديو (اتركها افتراضية) |
| ⚠️ `OTP_DEV_MODE` | **خلّيه `false` أو شيله في الإنتاج.** لو `true` بيرجّع توكن إعادة تعيين كلمة السر في الرد (للتجارب فقط) |

توليد سر بسرعة:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

---

## 3) النشر على Railway (خدمة واحدة + Postgres)

المشروع بينشر كـ **خدمة واحدة**: بناء الـapi بيبني الـweb كمان، والـapi بيقدّم
`apps/web/dist` على `/` (والـAPI تحت `/api`). فمافيش CORS ولا `VITE_API_URL`.

1. أنشئ مشروع Railway وأضف **PostgreSQL**.
2. أضف خدمة من ريبو GitHub (`main`). الـDockerfile فيه `ffmpeg` + `openssl`.
3. اضبط المتغيّرات من قسم (2)، وأهمها `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
4. أضف **Volume دائم** على `/data` (وخلي `STORAGE_LOCAL_PATH=/data/storage`).
5. أوامر الخدمة (من README):
   - Build: `npm run build --workspace=@darsly/api`
   - Start: `npm run start --workspace=@darsly/api` (بيشغّل `prisma migrate deploy` قبل الإقلاع)
6. أول مرة بس — اعمل seed من جهازك على قاعدة الإنتاج:
   ```bash
   DATABASE_URL="<DATABASE_PUBLIC_URL>" npm run db:seed --workspace=@darsly/api
   ```
7. كل `git push` على `main` بيعمل redeploy تلقائي.

---

## 4) 🚑 حلّ مشكلة الـMigration الحالية (P3009)

**الأعراض:** الـdeploy بيقف بـ
`P3009 … migration 20260712190602_manual_payment_proof_accounts … failed`.

**السبب:** الـmigration كانت بتضيف `Payment.updatedAt NOT NULL` من غير default على
جدول فيه صفوف. **اتصلحت في الكود** (بقت idempotent + backfill).

> ✅ **إصلاح تلقائي:** أمر الإقلاع بقى `sh scripts/start.sh` اللي بيعمل
> `migrate deploy`، ولو فشل بـP3009 بيفكّ القفل تلقائياً (`resolve --rolled-back`)
> ويعيد المحاولة. يعني **مجرّد Redeploy على Railway كفاية** — مش محتاج أوامر يدوي.
> الخطوات اليدوية تحت للطوارئ فقط.

لو حبيت تعملها يدوي (اختياري):

> `<PUBLIC_URL>` = رابط Postgres العام من Railway (Variables → `DATABASE_PUBLIC_URL`).

### الطريقة (أ) — الحفاظ على البيانات (مُوصى بها)
```bash
# 1) علّم الـmigration الفاشلة إنها اترجعت عشان تتطبّق تاني بالنسخة المصلَّحة:
DATABASE_URL="<PUBLIC_URL>" npx prisma migrate resolve \
  --rolled-back 20260712190602_manual_payment_proof_accounts \
  --schema apps/api/prisma/schema.prisma

# 2) طبّق الـmigrations المعلّقة (المصلَّحة + payment_events):
DATABASE_URL="<PUBLIC_URL>" npx prisma migrate deploy \
  --schema apps/api/prisma/schema.prisma
```
بعدها اعمل Redeploy على Railway — هيقلع عادي.

### الطريقة (ب) — قاعدة نظيفة (لو البيانات ديمو ومش مهمة)
```bash
DATABASE_URL="<PUBLIC_URL>" npx prisma migrate reset --force \
  --schema apps/api/prisma/schema.prisma
DATABASE_URL="<PUBLIC_URL>" npm run db:seed --workspace=@darsly/api
```
> ⚠️ الطريقة (ب) **بتمسح كل بيانات الإنتاج**.

بعد أي طريقة، تأكّد إن `git push` الأخير (فيه إصلاح الـmigration) وصل، وإن الخدمة
اتعملها Redeploy.

---

## 5) الموبايل — تثبيت التطبيق (PWA)

الويب **PWA** قابل للتثبيت (manifest + service worker + أيقونات).

- **أندرويد (Chrome):** افتح الدومين → قائمة المتصفح → **"تثبيت التطبيق / Add to Home screen"**.
- **آيفون (Safari):** شارك → **"إضافة إلى الشاشة الرئيسية"**.
- يشتغل standalone بأيقونة درسلي، ويفتح آخر صفحة محفوظة offline.

> لدعم آيفون بشكل كامل يُفضّل إضافة أيقونات PNG (192/512) في `apps/web/public/`
> بجانب الـSVG الحالية — تحسين تجميلي اختياري.

---

## 6) تطبيق مستقبِل الدفعات (Android Listener)

التحقّق التلقائي بيحتاج تطبيق أندرويد صغير على **موبايل المحفظة المستلِمة**
يقرأ إشعارات فودافون كاش/إنستاباي ويبعتها للباك إند. التفاصيل الكاملة + كود Kotlin
في [`docs/android-payment-listener.md`](./android-payment-listener.md). باختصار:

1. ابنِ التطبيق (Android Studio) وحط فيه `LISTENER_KEY = PAYMENT_LISTENER_KEY`
   والدومين `https://<your-domain>/api/v1/payment-events`.
2. ثبّته على موبايل الاستلام وامنحه **Notification Access**.
3. جرّب من غير موبايل عبر:
   ```bash
   API="https://<your-domain>/api/v1" KEY="<PAYMENT_LISTENER_KEY>" \
     bash scripts/simulate-payment-event.sh INSTAPAY 450 TXN12345
   ```
4. الأدمن يشوف الأحداث (تمّت المطابقة/بدون مطابقة) في **الأدمن → الدفعات**.

مستقبلاً: استبدله بـ Paymob/Fawry webhook على نفس الـendpoint من غير تغيير باقي النظام.

---

## 7) شيك ليست الاستقرار (Production checklist — 100%)

- [ ] `JWT_ACCESS_SECRET` و`JWT_REFRESH_SECRET` أسرار قوية وفريدة.
- [ ] `PAYMENT_LISTENER_KEY` سر قوي (مش الافتراضي).
- [ ] `OTP_DEV_MODE` = `false` أو مشيل.
- [ ] `ALLOWED_ORIGINS` = الدومين العام الصحيح.
- [ ] Volume دائم على `/data` و`STORAGE_LOCAL_PATH=/data/storage`.
- [ ] مشكلة الـP3009 اتحلّت (قسم 4) والـdeploy أخضر.
- [ ] حسابات الاستلام مضبوطة (الأدمن → الدفعات → حسابات الاستلام).
- [ ] عمولة المنصة لكل مدرس مضبوطة (افتراضي 20%).
- [ ] نسخ احتياطي دوري لقاعدة Postgres (Railway backups / cron `pg_dump`).
- [ ] راجع الـsmoke بعد النشر (قسم 8).
- [ ] (اختياري) رفع الملفات على S3 (`STORAGE_DRIVER=s3`) بدل القرص المؤقت.

---

## 8) تحقّق بعد النشر (Smoke)

على جهاز فيه الريبو، شغّل مقابل الدومين:
```bash
API="https://<your-domain>/api/v1" bash scripts/smoke-auth.sh     # 24 فحص
API="https://<your-domain>/api/v1" bash scripts/smoke-phase6.sh   # 20 فحص (اختبارات/واجبات/شهادات)
```
أو يدوياً: افتح `/login` → سجّل دخول أدمن → راجع لوحة الأدمن، وطالب → جرّب "ادفع واشترك".

---

## 9) خرائط سريعة

- **كود الـauth**: `apps/api/src/auth/*`
- **الدفع اليدوي + التحقق التلقائي**: `apps/api/src/payments/{manual-payments,payment-matching,payment-events}.*`
- **الدفتر المالي**: `apps/api/src/payments/ledger.service.ts`
- **الفيديو المحمي**: `apps/api/src/{video,playback}/*`
- **الـschema**: `apps/api/prisma/schema.prisma`
- **متغيّرات الويب**: same-origin في الإنتاج، `VITE_API_URL` محلياً فقط عند الحاجة.
