# درسلي — دليل النشر والتشغيل الكامل (Operator Guide)

كل اللي محتاجه عشان تشغّل المشروع محلياً، تنشره على Railway، وتتأكد إن اللي نشرته
وصل فعلاً.

> **الإنتاج**: `https://darslyapi-production.up.railway.app` — خدمة واحدة بتخدم
> الـweb على `/` والـAPI تحت `/api/v1`. الديبلوي auto على أي push لـ`main`.
> **`darsly.app` مش مملوك**؛ والدومين `darsly.up.railway.app` بيرجّع
> "Application not found" — متستخدمهوش للتحقق.

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
| ⭐ `NODE_ENV` | لازم `production` — يفعّل الفحص الصارم للأسرار عند الإقلاع (سكربت الإقلاع بيضبطه تلقائياً) |
| ⭐ `JWT_ACCESS_SECRET` | سر عشوائي طويل (≥32 حرف). **الإقلاع بيفشل في الإنتاج لو ناقص/قيمة افتراضية/قصير** |
| ⭐ `JWT_REFRESH_SECRET` | سر عشوائي طويل مختلف (لازم يختلف عن الـaccess) |
| `VIDEO_SIGNING_SECRET` | سر توقيع روابط الفيديو. لو فاضي بيرجع لـ`JWT_ACCESS_SECRET` (مفيش fallback غير آمن بعد الآن) |
| `JWT_ACCESS_TTL` | مثال `900s` (١٥ دقيقة) |
| `JWT_REFRESH_TTL` | مثال `30d` |
| ⭐ `ALLOWED_ORIGINS` | الدومين العام، مثال `https://darsly.up.railway.app` |
| ⭐ `PAYMENT_LISTENER_KEY` | سر مشترك للـAndroid listener (لو فاضي، الـ endpoint بيرفض) |
| `MAX_CONCURRENT_SESSIONS_DEFAULT` | مثال `3` |
| `STORAGE_DRIVER` | `local` (افتراضي) أو `s3` |
| `STORAGE_LOCAL_PATH` | `/data/storage` (قرص Railway الدائم) |
| `HLS_KEY_ROTATION_SECONDS`, `SIGNED_URL_TTL_SECONDS` | إعدادات الفيديو (اتركها افتراضية) |
| ⚠️ `OTP_DEV_MODE` | **خلّيه `false` أو شيله في الإنتاج.** لو `true` بيرجّع توكن إعادة تعيين كلمة السر في الرد (للتجارب فقط) |
| `DAILY_API_KEY` | مفتاح Daily للفصل المباشر. **سر سيرفر — عمره ما يروح للبراوزر**: اللي ماسكه يقدر يعمل غرف ويدخل أي حصة. من [dashboard.daily.co](https://dashboard.daily.co) → Developers. لو فاضي، الفصل الداخلي بيتعطّل والجلسات اللي فيها لينك زوم بتفضل شغّالة |
| `DAILY_DOMAIN` | دومين الفريق على Daily، مثال `yourteam.daily.co` |
| `DEEPGRAM_API_KEY` | مفتاح Deepgram لتفريغ الحصص. **سر سيرفر.** حطّه هنا وبس: الـAPI بيوصّله بدومين Daily بنفسه عند أول حصة، وبيعيد توصيله لو اتغيّر. من [console.deepgram.com](https://console.deepgram.com) → API Keys. لو فاضي، الحصة شغّالة عادي بس من غير ملخّص |

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

## 4) الميجريشنز — القاعدة الأهم

> **متطبّقش ميجريشن على قاعدة الإنتاج بإيدك.**

الميجريشنز **مكتوبة بالإيد** في مجلدات، ومحميّة بـ`IF NOT EXISTS` و
`DO $$ … EXCEPTION WHEN duplicate_object` عشان إعادة التطبيق تبقى آمنة. أمر
الإقلاع (`sh scripts/start.sh`) بيعمل `migrate deploy` لوحده، ولو فشل بـP3009
بيفكّ القفل ويعيد المحاولة. يعني **Redeploy لوحده كفاية**.

تطبيق ميجريشن يدوي على الإنتاج قبل ما الكود يوصل هو اللي عمل انقطاع خدمة قبل
كده — القاعدة اتعدّلت والكود القديم مابقاش يعرف يقراها.

### ✅ التحقق بعد الديبلوي (مش اختياري)
Railway بياخد وقت، والبناء ممكن يفشل من غير ما يقول. الطريقة الوحيدة اللي بتعتمد
عليها: اعمل poll على الإنتاج لحد ما تشوف **string فريدة للتغيير نفسه**.

```bash
# مثال: انتظر لحد ما قاعدة CSS جديدة تظهر في البَندل المنشور
for i in $(seq 1 60); do
  css=$(curl -s https://darslyapi-production.up.railway.app/ \
        | grep -o '/assets/index-[A-Za-z0-9_-]*\.css' | head -1)
  curl -s "https://darslyapi-production.up.railway.app$css" | grep -q 'scroll-x' \
    && { echo "SHIPPED $css"; break; }
  sleep 20
done
```

اختار string موجودة **في التغيير ده بس**. استخدام كلمة موجودة قبل كده بيديك
نتيجة إيجابية كاذبة — وده حصل، واتقال إن حاجة اتنشرت وهي لأ.

---

## 4b) 📕 ملحق تاريخي — مشكلة P3009 (اتحلّت)

> القسم ده متسيب للمرجع بس. الإصلاح التلقائي في `scripts/start.sh` بيغطيها.

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

## 4c) الفصل المباشر (Daily)

الغرف والتوكنات بتتعمل من الباك إند بس — **مفيش webhooks ولا endpoint عام
محتاج تسجيل**، فمفيش خطوة إعداد على Daily غير إنك تجيب المفتاح والدومين وتحطهم
في المتغيّرات فوق.

- الغرف بتتعمل **وقت ما المدرّس يدوس «ابدأ»** وبتتمسح لما ينهي الجلسة، ومعاها
  `exp` بتقفلها لوحدها لو المسح ما نجحش — يعني مفيش غرف مفتوحة بتتراكم على
  الحساب.
- الحضور متسجّل بنبضات من المتصفّح (`POST /live/:id/heartbeat`) مش بـwebhooks.
  الحد المعروف: لو التاب اتقفل فجأة ممكن آخر ≤٣٠ ثانية ما تتحسبش. الرقم بيقلّ
  مش بيزيد، وده الاتجاه الآمن.
- **التسجيل** متحقَّق منه وشغّال على الحساب الحالي، وبيبدأ من المتصفّح (توكن
  المالك هو اللي بيسمح بيه).
- **التفريغ (Transcription) بيتفعّل بمتغيّر واحد: `DEEPGRAM_API_KEY`.** ده إعداد
  على مستوى دومين Daily مش على مستوى الغرفة، والـAPI هو اللي بيعمله: عند أول
  حصة بعد الديبلوي بيقرا إعداد الدومين، ولو مش موصّل بنفس المفتاح بيوصّله
  (`POST https://api.daily.co/v1/` بـ`enable_transcription: deepgram:<key>`).
  - **تدوير المفتاح:** اعمل مفتاح جديد على Deepgram → حدّث المتغيّر على Railway →
    Redeploy → احذف القديم من Deepgram. أول حصة بعدها بتعيد التوصيل لوحدها.
    **متحدّثش دومين Daily بإيدك بـcurl** — المفتاح اللي بيتكتب في تيرمنال أو شات
    هو مفتاح اتسرّب، وده بالظبط اللي حصل مرّة.
  - **إزاي تعرف إنه اشتغل:** في لوج الديبلوي، عند أول حصة:
    `Transcription provider wired to the Daily domain from DEEPGRAM_API_KEY`.
    المفتاح نفسه عمره ما بيتكتب في اللوج، ولا إعداد الدومين (لأن Daily بترجّعه
    فيه بالنص الصريح).
  - **من غيره الحصة متكسرش:** الفيديو والشات والحضور والتسجيل كله بيفضل شغّال،
    والمنصّة بتقول للمدرّس السبب صراحةً (`TRANSCRIPTION_UNAVAILABLE`) بدل ما
    تقول له «مفيش كلام اتسجّل» وهو قاعد شارح ساعة.
  - **اللغة بتتبعت من السيرفر** (`TeacherProfile.language`، عربي افتراضياً) مع
    `nova-2`. من غيرها Deepgram بيفترض إنجليزي وبيطلّع نص فاضي لحصة عربي.
- **الملخّص الذكي** بيشتغل على طابور `AiJob` الموجود، يعني بيحترم
  `AI_ACADEMY_ENABLED` و`AI_WORKER_ENABLED`. **لو الاتنين مقفولين، الملخّصات
  هتفضل في الطابور من غير ما تتنفّذ** — مش باج، بس حاجة لازم تتعرف.
- **تدوير المفتاح**: غيّره من داشبورد Daily وحدّث `DAILY_API_KEY` على Railway.
  الجلسات الشغّالة وقتها بتكمّل (التوكنات اتعملت خلاص)، والجلسات الجديدة
  بتستخدم المفتاح الجديد.

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
- [ ] `NODE_ENV=production` (الفحص الصارم للأسرار بيعتمد عليه — سكربت الإقلاع بيضبطه).
- [ ] `OTP_DEV_MODE` = `false` أو مشيل (لو `true` في الإنتاج **الإقلاع بيفشل عمداً** — كان بيسرّب توكن إعادة تعيين كلمة السر).
- [ ] `ALLOWED_ORIGINS` = الدومين العام الصحيح.
- [ ] Volume دائم على `/data` و`STORAGE_LOCAL_PATH=/data/storage`.
- [ ] الـdeploy أخضر، **ومتحقّق منه** بـstring فريدة (قسم 4).
- [ ] `RESEND_API_KEY` مضبوط، ويفضّل الدومين يبقى verified — من غير كده الرسايل
      بتتبعت من `onboarding@resend.dev` وبتوصل لصاحب الحساب بس.
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
- **الثيمات والتخصيص**: `apps/api/src/studio/*` — و[`STUDIO.md`](./STUDIO.md).
- **قواعد الواجهة**: [`UI-CONVENTIONS.md`](./UI-CONVENTIONS.md).

### ملاحظات تشغيل متفرّقة
- الأعمال في الخلفية (transcode) **مفيهاش retry**: ديبلوي في نصّ التحويل بيضيّع
  الشغلانة. اعمل الديبلوي وقت هادي، أو أعد رفع الفيديو بعده.
- `yt-dlp` مش مثبّت على نسخة عمداً — بيتكسر لما المواقع تتغيّر، فالأحدث أضمن.
- قاعدة الإنتاج بيتوصل لها عن طريق proxy، وسكربتات الصيانة المؤقتة بتتكتب في
  `apps/api/scripts/_*.ts` **وبتتمسح بعد الاستخدام**.
