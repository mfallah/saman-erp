# نصب تازه و تحویل (Fresh-host install & handover)

هدف: راه‌اندازی Saman ERP روی یک هاست خالی و انتقال داده از محیط فعلی.

## ۱) پیش‌نیازها
- Docker + Docker Compose
- PostgreSQL 16 (یا سرویس مدیریت‌شده) و Redis
- Node.js 22 و pnpm 11 برای بیلد (یا استفاده از ایمیج آماده)

## ۲) گرفتن کد و تنظیم محیط
```bash
git clone <repo> saman-erp && cd saman-erp
cp .env.example .env
# مقادیر الزامی را پر کنید:
#   DATABASE_URL / MIGRATION_DATABASE_URL
#   REDIS_URL
#   JWT_ACCESS_SECRET / REFRESH_PEPPER / OTP_PEPPER
#   APP_ENCRYPTION_KEY   (کلید اعتبارنامهٔ کانال‌ها — از محیط قبلی بردارید)
#   LIMO_API_KEY / SMS_MODE=limo
#   ADMIN_PASSWORD یا RUN_SEED_ON_START=1
```

## ۳) بیلد و اجرا
```bash
pnpm install
pnpm build
docker compose up -d --build
# بررسی سلامت
curl -s http://localhost:80/api/v1/health/live
```

## ۴) پایگاه داده
```bash
# مهاجرت‌ها به ترتیب 0001..0005 اجرا می‌شوند (RUN_MIGRATIONS_ON_START=1)
pnpm --filter @saman/db migrate
# یا با سرویس: docker compose logs api | grep migrate
```
اتصال: `postgres://USER:PASS@HOST:5432/DB` — همهٔ اشیاء در schema `erp` هستند و نقش‌های
`saman_app` / `saman_worker` / `saman_readonly` باید وجود داشته باشند (در Postgres مدیریت‌شده
بخش GRANT ها توسط رانِر حذف می‌شود).

## ۵) انتقال داده از محیط فعلی (بکاپ/ری‌استور)
```bash
# بکاپ
pg_dump --no-owner --format=custom "$SRC_DATABASE_URL" -f saman.dump
# ری‌استور روی هاست تازه
pg_restore --no-owner --clean --if-exists -d "$DST_DATABASE_URL" saman.dump
# بازسازی مهاجرت‌ها در صورت نیاز
pnpm --filter @saman/db migrate
```
نکته‌های مهم:
- `APP_ENCRYPTION_KEY` را عوض نکنید، وگرنه اعتبارنامه‌های کانال‌ها قابل رمزگشایی نیستند.
- رازهای لیمو/دیجی‌کالا در env سرور هستند، نه در DB.
- پس از ری‌استور: `RUN_SEED_ON_START=0` بگذارید تا داده‌های عملیاتی دست‌نخورده بمانند.

## ۶) تأیید پس از نصب (چک‌لیست)
```bash
node scripts/verify-otp-race.mjs            # OTP اتمیک → PASS
node scripts/verify-inventory-invariants.mjs # صحت انبار → 12/12
node scripts/verify-audit-chain.mjs         # زنجیرهٔ audit → PASS
```
سپس در UI: ورود مدیر → کانال‌ها (اتصال/همگام‌سازی) → سفارش‌ها (وجود اقلام) →
ایستگاه برداشت (نام/عکس/اسکن) → بسته‌بندی (تفکیک کانال) → پیامک‌ها (آمار).

## ۷) پشتیبان‌گیری دوره‌ای
- روزانه: `pg_dump` + کپی فایل‌های `.env` و کلید رمزنگاری در محل امن
- نگه‌داری حداقل ۷ نسخه؛ تست ری‌استور ماهانه الزامی است
