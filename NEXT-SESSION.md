# اللي فاضل لبكرة — تحسين الفرونت (الجزء 2) + مهام معلّقة

آخر كوميت: `0d6b238` (Frontend polish part 1) — مدفوع على `main`.

## ✅ اللي خلص (الجزء 1)
- شريط علوي زجاجي (TopBar): بحث في النص + جرس إشعارات حقيقي + قائمة المستخدم + تبديل اللغة.
- API الإشعارات (`GET /notifications`, `PATCH /notifications/:id/read`, `read-all`).
- Layout جديد: بلوك براند بتدرّج، nav بحبة نشطة، كارت حساب تحت، دروار للموبايل.
- primitives في `index.css`: أزرار برفعة hover، `.card-hover`، `.glass`، skeletons، سكرول بار.
- `ui.tsx`: `Skeleton`, `CardGridSkeleton`, `PageHeader`.
- Discovery: بحث من الـ TopBar (`?q`)، skeletons، كروت معلمين معاد تصميمها.
- Login: اتصلح تداخل البراند مع السطر، شعار بتدرّج.
- Seed: صورة مميزة لكل دورة.

## 🔜 المطلوب بكرة (بالترتيب)

### 1. تنظيف بيانات الـ smoke (كان اتعمله reject — نفّذه الأول)
سكريبتات الاختبار سابت دورات "تجريبية للاختبار" وطلاب "طالب الاختبار" بتلوّث لوحة المعلم.
شغّل ده (أو الأفضل: نظّف السكريبتات إنها تمسح بعد نفسها):
```bash
docker exec darsly-postgres psql -U darsly -d darsly -c "
DELETE FROM \"Payment\" p USING \"Course\" c WHERE p.\"courseId\"=c.id AND (c.title LIKE '%تجريبية%' OR c.title LIKE '%drip-switch%');
DELETE FROM \"Enrollment\" e USING \"Course\" c WHERE e.\"courseId\"=c.id AND (c.title LIKE '%تجريبية%' OR c.title LIKE '%drip-switch%');
DELETE FROM \"Lesson\" l USING \"CourseUnit\" u, \"Course\" c WHERE l.\"unitId\"=u.id AND u.\"courseId\"=c.id AND (c.title LIKE '%تجريبية%' OR c.title LIKE '%drip-switch%');
DELETE FROM \"CourseUnit\" u USING \"Course\" c WHERE u.\"courseId\"=c.id AND (c.title LIKE '%تجريبية%' OR c.title LIKE '%drip-switch%');
DELETE FROM \"Coupon\" WHERE code LIKE 'SMOKE%';
DELETE FROM \"Course\" WHERE title LIKE '%تجريبية%' OR title LIKE '%drip-switch%';
DELETE FROM \"User\" WHERE \"fullName\" LIKE '%طالب الاختبار%' OR \"fullName\"='طالب تجريبي';"
```
ثم `npm run db:seed --workspace=@darsly/api` عشان الصور المميزة تتطبق.
**تحسين دائم:** خلّي `scripts/smoke-phase2.sh` و`smoke-phase3.sh` يمسحوا الدورة/الكوبون اللي أنشأوهم في النهاية.

### 2. باقي شاشات الفرونت — استخدم `PageHeader` + skeletons + الـ primitives الجديدة
الشاشات دي لسه بتستخدم هيدر inline قديم و`Spinner` بدل skeletons:
- `apps/web/src/pages/student/TeacherProfilePage.tsx` — الهيرو كويس، بس استخدم skeleton بدل Spinner.
- `apps/web/src/pages/student/CourseDetailPage.tsx` — هيدر → `PageHeader` أسلوب، حسّن كارت الاشتراك.
- `apps/web/src/pages/teacher/TeacherDashboardPage.tsx` — الهيدر + كروت الإحصائيات (أيقونة يمين، رقم كبير)، شيل زرار "دورة جديدة" العايم وحطه في `PageHeader action`.
- `apps/web/src/pages/teacher/TeacherCoursesPage.tsx` — `PageHeader`، **واقرأ `?q` من الـ URL** (TopBar بيبعت للمعلم `/teacher/courses?q=`) وفلتر بالعنوان.
- `apps/web/src/pages/teacher/CourseBuilderPage.tsx` — كبير بس شكله كويس؛ بس وحّد الهيدر.
- `apps/web/src/pages/teacher/TeacherEnrollmentsPage.tsx` — `PageHeader`؛ الجدول كويس.
- `apps/web/src/pages/teacher/TeacherCouponsPage.tsx` — `PageHeader`؛ الجدول كويس.
- `apps/web/src/pages/student/SecureVideoPlayerPage.tsx` — شغّال ومتحقق منه؛ تحسينات بسيطة بس.

نمط موحّد لكل شاشة:
```tsx
import { PageHeader, CardGridSkeleton } from '../../components/ui';
// ...
<div className="mx-auto max-w-container px-6 py-8 sm:px-8">
  <PageHeader title={t('...')} subtitle={t('...')} action={<button className="btn-primary">...</button>} />
  {isLoading ? <CardGridSkeleton/> : ...}
</div>
```

### 3. تحقّق بصري (مهم جداً — المستخدم حسّاس لجودة الشكل)
شغّل السيرفرات ثم لقطات في متصفح حقيقي:
```bash
# API: npm run dev --workspace=@darsly/api  |  Web: npm run dev --workspace=@darsly/web
node /tmp/.../scratchpad/snap.mjs all   # (السكريبت موجود؛ أو أعد كتابته)
```
راجع كل شاشة عين بعين مع المرجع في:
`/home/ahmedeldeeb/Pictures/stitch_hessa_edtech_platform_ui/` (استبدل "Hessa/حصة" بـ "درسلي").
لاحظ: descenders العربية (حرف ي/ج) بتتقطع مع `leading-none` — استخدم `leading` عادي أو `pb`.

### 4. Build + commit + push
```bash
npm run build   # لازم يعدي أخضر
git add -A && git commit -m "Frontend polish (part 2): remaining screens to reference fidelity"
git push origin main   # بيعمل auto-deploy على Railway
```

## 📌 مهام معلّقة أكبر (لما توافق)
- **فيديو الإنتاج على Railway**: محتاج (أ) ffmpeg في صورة البناء [Dockerfile أو railpack packages]، (ب) تخزين S3 (قرص Railway مؤقت). المُحوّل جاهز — بس bucket + مفاتيح + `STORAGE_DRIVER=s3`.
- **Phase 4**: الشات (Socket.io)، الإشعارات اللحظية، تتبّع التقدّم، راحة الطالب. (مستني تأكيدك)
- `OTP_DEV_MODE=true` على الإنتاج — لازم يتقفل قبل أي إطلاق حقيقي.

## معلومات سريعة
- حسابات: طالب `01011111111` كود `0000` · معلم `khaled@darsly.app`/`Teacher@12345` · أدمن `admin@darsly.app`/`Admin@12345`.
- API محلي: `:4000` (Swagger `/api/docs`) · Web: `:5173` · Postgres: `5434`.
- لايف: https://darslyapi-production.up.railway.app
- سمووك: `bash scripts/smoke-auth.sh` (18) · `smoke-phase2.sh` (37) · `smoke-phase3.sh` (21، محتاج ffmpeg + `scratchpad/sample.mp4`).
