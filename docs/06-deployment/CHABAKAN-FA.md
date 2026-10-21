# نصب و راه‌اندازی Saman ERP روی چابکان

> نسخهٔ سند: ۱٫۰ · تاریخ: ۱۴۰۵/۰۷/۲۹ · مخاطب: مدیر پروژه/توسعه‌دهنده
> این سند برای استقرار **همین ریپو** (`saman-erp`) روی پلتفرم ابری چابکان نوشته شده است.
> همهٔ مسیرهای پنل مطابق مستندات چابکان در تاریخ بالا هستند؛ اگر پنل تغییر کرد، عنوان‌ها ممکن است جابه‌جا شوند.

---

## ۰) خلاصهٔ تصمیم: چه چیزی بخریم؟

Saman ERP از سه فرآیند تشکیل شده است:

| فرآیند | نقش | روی چابکان |
|---|---|---|
| API | HTTP API (NestJS/Fastify) روی پورت ۳۰۰۰ | یک سرویس **Docker** |
| Worker | پردازش صف/outbox، ارسال پیامک، کارهای زمان‌بندی‌شده | یک سرویس **Docker** دیگر (همان ایمیج، `APP_ROLE=worker`) |
| Web | پنل مدیریت (React/Vite) | سرویس **Static** |

و سه سرویس داده:

| سرویس | کاربرد |
|---|---|
| **PostgreSQL** | دیتابیس اصلی (۲۲۶ جدول، مایگریشن‌ها) |
| **Redis** | صف/کش/نرخ‌محدودیت و `health/ready` |
| **MinIO / S3** | فایل‌ها، پیوست‌ها، خروجی گزارش‌ها (اگر MinIO آماده نبود، Docker یا S3 بیرونی — بخش ۴) |

**سبد خرید پیشنهادی (برای شروع واقعی، نه تست):**

| # | سرویس | پلن | قیمت ۳۰ روزه (تومان، پیش از مالیات)\* |
|---|---|---|---|
| ۱ | هاست ابری Docker — `saman-api` | **نقره** (۲GB RAM، ۱ هسته، ۱۰GB) | ۱٬۰۵۴٬۷۲۸ |
| ۲ | هاست ابری Docker — `saman-worker` | **برنز** (۱GB RAM، ۰٫۷۵ هسته، ۷GB) | ۶۷۶٬۴۷۶ |
| ۳ | دیتابیس PostgreSQL — `saman-db` | **نقره** (۲GB RAM، ۱۰GB) | ۱٬۰۵۴٬۷۲۸ |
| ۴ | دیتابیس Redis | **اقتصادی** | ۲۰۲٬۴۶۴ |
| ۵ | MinIO: اگر «برنامه آماده» موجود نبود، یک سرویس **Docker** اقتصادی برای MinIO | **اقتصادی** | ۲۰۲٬۴۶۴ (یا S3 بیرونی) |
| ۶ | هاست Static — `saman-web` | ارزان‌ترین پلن | در پنل چک کنید |

\* قیمت‌ها از صفحهٔ محصولات چابکان (اکتبر ۲۰۲۶) و **پیش از مالیات** هستند؛ مبلغ نهایی در هاب/سبد خرید نشان داده می‌شود:
[Docker](https://chabokan.net/products/cloud-hosting/docker/) · [PostgreSQL](https://chabokan.net/products/database/postgresql/) · [Redis](https://chabokan.net/products/database/redis/)

**جمع تقریبی: ~۳٬۲ میلیون تومان در ماه + مالیات** (بدون دامنه و بدون پلن Static).
اگر فقط می‌خواهید تست کنید: API اقتصادی + PG پایه + Redis اقتصادی کافی است، ولی Worker را هم بسازید چون بدون آن هیچ سند حسابداری/پیامکی پردازش نمی‌شود.

> 💡 ۱۰۰ هزار تومان اعتبار رایگان اولیه هم وجود دارد، اما **سرویس Docker و Python مشمول کیف پول هدیه نیستند** (طبق FAQ چابکان).

---

## ۱) پیش‌نیازها

1. حساب چابکان + کیف پول شارژشده.
2. دامنه (مثلاً `carexy.shop`) با دسترسی به DNS.
3. دسترسی به ریپوی خصوصی `github.com/mfallah/saman-erp` (توکن GitHub با دسترسی read).
4. یک دستگاه/سرور محلی برای **build پنل وب** (Node 22 + pnpm 11) — یا از Docker استفاده کنید.
5. فایل رمزها: روی سیستم خود `bash scripts/gen-secrets.sh` را اجرا کنید و مقادیر `JWT_ACCESS_SECRET`، `OTP_PEPPER`، `REFRESH_PEPPER`، `APP_ENCRYPTION_KEY` را نگه دارید.

---

## ۲) ساخت دیتابیس PostgreSQL

1. پنل: **ساخت سرویس جدید ← دیتابیس ابری ← PostgreSQL**.
2. موقعیت ابری: همان موقعیتی که سرویس‌های Docker را می‌سازید (مثلاً ایران/آلمان) — برای کمترین تأخیر.
3. نسخه: **۱۶** را انتخاب کنید (مستندات می‌گوید نسخه قابل انتخاب است؛ کد ما روی ۱۶ هدف‌گذاری شده و روی ۱۸ هم تست شده).
4. پلن: **نقره** (۲GB RAM / ۱۰GB) برای شروع؛ رشد بعدی آسان است.
5. بعد از ساخت (چند دقیقه)، از **داشبورد سرویس ← مشخصات سرویس** این‌ها را بردارید:
   - `HOST`، `PORT`، `DATABASE`، `USER`، `PASSWORD`
6. اگر پنل **فایروال** دارد، مطمئن شوید سرویس‌های Docker می‌توانند به این دیتابیس وصل شوند (در چابکان معمولاً شبکهٔ داخلی باز است؛ در صورت شک، در تیکت بپرسید).

📚 مرجع: [نصب PostgreSQL در چابکان](https://docs.chabokan.net/database/postgresql/install/)

ساخت `DATABASE_URL`:

```text
postgres://USER:PASSWORD@HOST:PORT/DATABASE
```

> ⚠️ **مهم:** دیتابیس مدیریت‌شدهٔ چابکان **یک کاربر مالک** می‌دهد و اجازهٔ `CREATE ROLE` نمی‌دهد.
> به همین دلیل پروژه حالت **Managed PostgreSQL** دارد:
> - `DB_MANAGED=true` — گارد تولیدی «دو نقش جدا» را غیرفعال می‌کند.
> - `MANAGED_PG=1` — هنگام مایگریشن، دستورهای ساخت Role/Grant به نقش‌های `saman_*` حذف می‌شوند.
>
> این یعنی در این حالت همه‌چیز با همان کاربر مالک اجرا می‌شود (کمی کمتر امن از حالت سه‌نقشی، اما سازگار با DB مدیریت‌شده).
> اگر بعداً PostgreSQL اختصاصی/خودمدیریت گرفتید، `MANAGED_PG=0` و `DB_MANAGED=false` بگذارید تا نقش‌های حداقلی ساخته شوند.

---

## ۳) ساخت Redis

1. **ساخت سرویس جدید ← دیتابیس ابری ← Redis**.
2. نسخه پیش‌فرض/۷ را انتخاب کنید؛ پلن اقتصادی کافی است.
3. از داشبورد: `HOST`، `PORT`، `PASSWORD`.
4. `REDIS_URL`:

```text
redis://:PASSWORD@HOST:PORT/0
```

📚 مرجع: [نصب Redis در چابکان](https://docs.chabokan.net/database/redis/install/)

> Redis فقط «کش» نیست: `/health/ready` بدون آن ۵۰۳ می‌دهد و صف/نرخ‌محدودیت کار نمی‌کند.

---

## ۴) فضای ذخیره‌سازی (S3) — وقتی MinIO آماده در دسترس نیست

سرویس آمادهٔ **Minio** در چابکان همیشه موجود نیست. سه گزینه دارید؛ به ترتیب اولویت:

### گزینهٔ ۱ (توصیه‌شده): MinIO را خودتان روی یک سرویس Docker اجرا کنید

همان پنل Docker که برای API استفاده می‌کنید، هر ایمیجی را اجرا می‌کند — پس MinIO را خودتان بسازید:

1. **ساخت سرویس جدید ← هاست ابری ← Docker** → نام `saman-minio` → پلن **اقتصادی/پایه**.
2. روش استقرار: «Dockerfile شخصی» و محتوای فایل [`deploy/chabakan/minio.Dockerfile`](../../deploy/chabakan/minio.Dockerfile) را بگذارید (کلیدها را عوض کنید):

```dockerfile
FROM minio/minio:latest
ENV MINIO_ROOT_USER=CHANGE_ME_ACCESS_KEY
ENV MINIO_ROOT_PASSWORD=CHANGE_ME_SECRET_KEY
EXPOSE 9000 9001
CMD ["server", "/data", "--console-address", ":9001"]
```

3. **دیسک‌ها ← افزودن دیسک** → مقصد `/data` (فضای MinIO اینجا پایدار می‌ماند).
4. **پورت‌ها**: داخلی `9000` (S3 API) و داخلی `9001` (کنسول) را باز کنید و به هرکدام یک دامنه/ساب‌دامنه بدهید:
   - `minio-api.carexy.shop` → پورت 9000
   - `minio-console.carexy.shop` → پورت 9001
5. وارد کنسول (`https://minio-console...`) شوید، با `MINIO_ROOT_USER/PASSWORD` لاگین کنید و باکت **`saman-files`** را بسازید (یا از `mc`).
6. مقادیر اپ:

```text
S3_ENDPOINT=https://minio-api.carexy.shop
S3_REGION=us-east-1
S3_BUCKET=saman-files
S3_ACCESS_KEY=<MINIO_ROOT_USER>
S3_SECRET_KEY=<MINIO_ROOT_PASSWORD>
S3_FORCE_PATH_STYLE=true
```

> ✅ مزیت: همه‌چیز داخل چابکان می‌ماند، بدون وابستگی به سرویس آمادهٔ MinIO.
> پورت ۹۰۰۰ باید از سرویس API قابل دسترسی باشد (اینترنت/دامنهٔ عمومی کافی است).

### گزینهٔ ۲: سرویس «فایل S3» چابکان (اگر در پنل دیده می‌شود)

مستندات چابکان برای Django/Laravel از «سرویس فایل S3» با `Bucket-Endpoint` / `Access-Key` / `Secret-Key` صحبت می‌کند.
اگر در پنل شما زیر **فضای ذخیره‌سازی** یا **برنامه‌های آماده** گزینهٔ S3 وجود داشت، همان را بسازید و:

```text
S3_ENDPOINT=https://<Bucket-Endpoint>
S3_BUCKET=<Bucket-Name>
S3_ACCESS_KEY=<Access-Key>
S3_SECRET_KEY=<Secret-Key>
S3_FORCE_PATH_STYLE=true
```

📚 [مستند اتصال S3 چابکان (Django)](https://docs.chabokan.net/simple-hosting/django/cloud-storage/)

### گزینهٔ ۳: Object Storage بیرونی سازگار با S3

اگر خواستید از چابکان خارج شوید، هر سرویس S3-compatible کار می‌کند؛ دو گزینهٔ رایج ایرانی:

**آروان‌کلاد** (Endpoint بر اساس منطقه):

```text
S3_ENDPOINT=https://s3.ir-thr-at1.arvanstorage.ir   # یا https://s3.ir-tbz-sh1.arvanstorage.ir
S3_REGION=ir-thr-at1
S3_BUCKET=saman-files
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
S3_FORCE_PATH_STYLE=true
```

📚 [SDK فضای ابری آروان](https://docs.arvancloud.ir/fa/developer-tools/sdk/object-storage/) · [محدودیت‌ها](https://docs.arvancloud.ir/fa/object-storage/limits)

**لیارا** (سازگار کامل با S3):

```text
S3_ENDPOINT=https://storage.iran.liara.space
S3_REGION=us-east-1
S3_BUCKET=saman-files
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
S3_FORCE_PATH_STYLE=true
```

📚 [Object Storage لیارا](https://docs.liara.ir/object-storage/about/)

> قبل از استقرار، با `mc` یا AWS CLI یک `put`/`get` ساده روی باکت بزنید تا Endpoint/کلید/Path-Style درست باشد.
> بعد از تغییر `S3_*` سرویس API و Worker را Restart کنید.

---

## ۵) ساخت سرویس API (Docker)

### ۵٫۱ ساخت سرویس

1. **ساخت سرویس جدید ← هاست ابری ← Docker**.
2. نام: `saman-api` — موقعیت ابری: همان دیتابیس — پلن: **نقره**.
3. روش استقرار:
   - **گزینهٔ A (پیشنهادی): «می‌خواهم Dockerfile شخصی خودم را ایجاد کنم».**
   - **گزینهٔ B:** «می‌خواهم از Docker Image استفاده کنم» (اگر ایمیج را در رجیستری خودتان push کرده‌اید).
4. ریپوی خصوصی را با Git در کنسول بیاورید (روش رسمی چابکان):

```bash
# در کنسول سرویس (مسیر پیش‌فرض)
rm -rf $(ls -A)
git clone https://USERNAME:TOKEN@github.com/mfallah/saman-erp.git
cd saman-erp && mv $(ls -A) ../ && cd ..
```

سپس سرویس را **Restart** کنید تا Dockerfile build شود.
📚 مراجع: [استقرار Docker](https://docs.chabokan.net/cloud-hosting/docker/deploy/) · [Git خصوصی](https://docs.chabokan.net/deploy/private-git/) · [Git](https://docs.chabokan.net/deploy/git/)

> Dockerfile مورد استفاده: `infra/docker/api.Dockerfile` (چندمرحله‌ای، کاربر غیرروت، `tini`، پورت ۳۰۰۰).
> در این فایل `ENTRYPOINT` یک اسکریپت است که با `APP_ROLE` بین `api` / `worker` / `migrate` سوییچ می‌کند.

### ۵٫۲ پورت

- **پورت‌ها ← افزودن پورت**: پورت داخلی = `3000` (پورت خارجی خودکار).
- دامنهٔ پیش‌فرض سرویس روی همان پورت کار می‌کند؛ بعداً دامنهٔ `api.erp.carexy.shop` را به آن وصل می‌کنیم.
📚 [مدیریت پورت](https://docs.chabokan.net/cloud-hosting/docker/ports/)

### ۵٫۳ متغیرهای محیطی

- **تنظیمات ← متغیرهای محیطی** → محتوای فایل [`deploy/chabakan/env.api.example`](../../deploy/chabakan/env.api.example) را پر کنید و بچسبانید (یا فایل `.env` را آپلود کنید).
- حداقلِ لازم: `DATABASE_URL`، `REDIS_URL`، `S3_*`، `LIMO_*`، `JWT_ACCESS_SECRET`، `OTP_PEPPER`، `REFRESH_PEPPER`، `APP_ENCRYPTION_KEY`، `CORS_ORIGINS`، `DB_MANAGED=true`، `MANAGED_PG=1`.
- بعد از هر ذخیره، چابکان سرویس را دوباره Deploy می‌کند (چند دقیقه قطعی).
📚 [متغیرهای محیطی](https://docs.chabokan.net/features/settings/env/)

### ۵٫۴ دیسک (اختیاری اما توصیه‌شده)

فقط برای فایل‌های موقت و لاگ محلی:

- **دیسک‌ها ← افزودن دیسک** → مقصد: `/app/apps/api/tmp`
- فایل‌های اصلی در MinIO نگهداری می‌شوند، پس دیسک بزرگ لازم نیست.
📚 [دیسک‌ها](https://docs.chabokan.net/simple-hosting/docker/disks/)

---

## ۶) مایگریشن، داده‌های پایه و کاربر ادمین

بعد از بالا آمدن سرویس API، از **کنسول** همان سرویس:

```bash
cd /app/apps/api

# 1) ساخت اسکیما (۲۲۶ جدول) — حالت DB مدیریت‌شده
MANAGED_PG=1 DB_MANAGED=true node /app/packages/db/dist/migrate.js

# 2) داده‌های پایه (نقش‌ها، ۴۱۴ مجوز، کدینگ حسابداری، کانال‌ها، تنظیمات)
#    اگر می‌خواهید رمز ادمین را خودتان تعیین کنید، قبل از اجرا:
export BOOTSTRAP_ADMIN_PASSWORD='یک-رمز-قوی-حداقل-۱۶-کاراکتری'
node /app/packages/db/dist/seed.js

# 3) یا ساخت/ریست یک ادمین اضافه
node /app/packages/db/dist/cli/create-admin.js \
  --username ops --mobile 09121234567 --name "مدیر عملیات" --role admin
```

- خروجی seed یک رمز یک‌بارمصرف چاپ می‌کند؛ آن را نگه دارید (یا `BOOTSTRAP_ADMIN_PASSWORD` بدهید).
- مایگریشن **idempotent** است؛ اجرای دوباره چیزی را خراب نمی‌کند (`schema_migrations`).
- اگر خطای `permission denied` دیدید، یعنی `MANAGED_PG=1` ست نشده و مایگریشن داشته Role می‌ساخته.

> هر بار نسخهٔ جدید SQL آمد، فقط همان دستور `migrate` را دوباره اجرا کنید.

---

## ۷) ساخت سرویس Worker (Docker)

1. **ساخت سرویس جدید ← هاست ابری ← Docker** → نام `saman-worker` → پلن **برنز**.
2. همان Git clone + Restart (همان ریپو و همان Dockerfile).
3. **هیچ پورتی باز نکنید** (Worker درخواست HTTP نمی‌گیرد).
4. متغیرها را از [`deploy/chabakan/env.worker.example`](../../deploy/chabakan/env.worker.example) بگذارید؛ مهم‌ترین تفاوت:

```text
APP_ROLE=worker
```

5. بقیهٔ مقادیر (DB/Redis/S3/Limo/رمزها) **باید دقیقاً با سرویس API یکی باشند**.
6. تعداد نمونه: ۱ کافی است؛ اگر بار زیاد شد، می‌توانید ۲ نمونه بدهید (صف با `FOR UPDATE SKIP LOCKED` امن است).

چه کارهایی می‌کند؟ ارسال outbox، ثبت خودکار اسناد حسابداری از رویدادها، اعلان‌ها، همگام‌سازی کانال‌ها و نگهداری دوره‌ای.

---

## ۸) استقرار پنل وب (Static)

روی سیستم خودتان (Node 22 + pnpm):

```bash
cd saman-erp
VITE_API_BASE=https://api.erp.carexy.shop/api/v1 pnpm --filter @saman/web build
# خروجی: apps/web/dist
```

سپس در چابکان:

1. **ساخت سرویس جدید ← هاست ابری ← Static** → نام `saman-web`.
2. فایل‌های داخل `apps/web/dist` را آپلود کنید (File Manager / CLI / FTP).
3. **SPA fallback**: پنل با مسیریابی سمت کلاینت کار می‌کند؛ باید همهٔ مسیرها به `index.html` برگردند.
   اگر در تنظیمات سرویس Static گزینهٔ nginx/fallback هست فعالش کنید؛ در غیر این صورت در تیکت بگویید
   «برای سرویس Static می‌خواهم fallback به index.html فعال شود». (مستند React چابکان همین را توضیح می‌دهد.)
4. متغیر `VITE_API_BASE` **در زمان build** داخل فایل‌های JS قرار می‌گیرد؛ بعد از تغییر دامنهٔ API باید دوباره build و آپلود کنید.

📚 [استقرار Static](https://docs.chabokan.net/cloud-hosting/static/deploy/) · [رفع ۴۰۴ سرویس React](https://docs.chabokan.net/faq/)

---

## ۹) دامنه و SSL

1. **دامنه‌ها** در هر سرویس:
   - `api.erp.carexy.shop` → سرویس `saman-api` → پورت داخلی `3000`
   - `erp.carexy.shop` → سرویس `saman-web`
2. رکوردهای DNS پیشنهادی: `CNAME` به دامنهٔ پیش‌فرض سرویس (یا NS کامل چابکان).
3. SSL رایگان با اتصال دامنه خودکار فعال می‌شود؛ در تنظیمات دامنه، **HTTPS redirect** را روشن کنید.
4. بعد از اتصال دامنه‌ها، این دو متغیر را در سرویس API به‌روزرسانی و ذخیره کنید:

```text
APP_URL=https://erp.carexy.shop
CORS_ORIGINS=https://erp.carexy.shop
```

📚 [دامنه‌ها](https://docs.chabokan.net/features/domains/domain-panel/) · [HTTPS](https://docs.chabokan.net/features/domains/https/)

---

## ۱۰) بررسی سلامت و اولین ورود

```bash
curl -fsS https://api.erp.carexy.shop/health/live    # 200
curl -fsS https://api.erp.carexy.shop/health/ready   # 200 (DB + Redis)
```

- `live` = فرآیند بالاست.
- `ready` = اتصال DB/Redis/صف برقرار است؛ اگر ۵۰۳ داد، Redis یا DATABASE_URL را چک کنید.

اولین ورود:

1. `https://erp.carexy.shop` را باز کنید.
2. با `admin` و رمزی که seed چاپ کرد (یا `BOOTSTRAP_ADMIN_PASSWORD`) وارد شوید.
3. کد OTP از طریق Limo ارسال می‌شود — مطمئن شوید `LIMO_API_KEY`/`LIMO_SENDER`/`LIMO_OTP_PATTERN_ID` درست است و شمارهٔ موبایل ادمین در دسترس است.
4. بعد از ورود، رمز را تغییر دهید و با `ops` یک کاربر دوم برای تأیید اسناد بسازید
   (چون **تأییدکنندهٔ سند نمی‌تواند خودِ ایجادکننده باشد**).

---

## ۱۱) بکاپ و بازیابی

| داده | روش |
|---|---|
| PostgreSQL | بکاپ خودکار روزانه + PITR در پنل دیتابیس؛ قبل از هر تغییر مهم: `pg_dump` دستی از کنسول |
| MinIO | بکاپ دوره‌ای با `mc mirror` یا ابزار پنل |
| فایل‌های تنظیمات/متغیرها | از دکمهٔ «دانلود خروجی متغیرها» در صفحهٔ env یک نسخه بگیرید و در جای امن نگه دارید |

نمونهٔ `pg_dump` از کنسول سرویس API (اگر `pg_dump` در ایمیج نبود، از سرویس دیتابیس/کنسول آن یا TablePlus استفاده کنید):

```bash
pg_dump "$DATABASE_URL" -Fc -f /tmp/saman-$(date +%F).dump
```

> در حالت فعلی ایمیج `pg_dump` نصب نیست؛ ساده‌ترین مسیر: بکاپ‌های خودکار چابکان + خروجی TablePlus.
> اگر خواستید داخل ایمیج داشته باشید، به `api.Dockerfile` بستهٔ `postgresql-client` اضافه کنید.

---

## ۱۲) کارهای زمان‌بندی و نگهداری

- Worker خودش کارهای دوره‌ای (پاکسازی، partition، رزروهای منقضی) را انجام می‌دهد؛ نیازی به cron برای این‌ها نیست.
- اگر cron جدا خواستید، در سرویس Docker چابکان فایل `cron-jobs` را در ریشهٔ پروژه بگذارید و در `Dockerfile` بستهٔ `cron` را نصب و `crontab` کنید
  (الگوی رسمی: [Cron در Docker](https://docs.chabokan.net/features/etc/cron-job/)).
- برای اطمینان از اجرای outbox، لاگ‌های سرویس worker را ببینید؛ باید `outbox dispatcher started` و پردازش رویدادها دیده شود.

---

## ۱۳) عیب‌یابی سریع

| نشانه | علت محتمل | راه‌حل |
|---|---|---|
| Build سرویس Docker شکست می‌خورد | Git clone ناقص/فایل‌ها جابه‌جا نشده | `ls` کنسول را چک کنید؛ `package.json` و `pnpm-lock.yaml` باید در ریشهٔ `/app` باشند؛ Restart |
| `Refusing to start: invalid production configuration` | متغیر اجباری تولیدی غایب | پیام دقیق در لاگ؛ معمولاً `CORS_ORIGINS`، `COOKIE_SECURE=true`، `SMS_MODE=limo`، طول رمزها |
| `DATABASE_URL must not use a superuser/owner-looking role` | `DB_MANAGED` ست نشده | `DB_MANAGED=true` |
| مایگریشن: `permission denied to create role` | `MANAGED_PG` ست نشده | `MANAGED_PG=1` |
| `/health/ready` = ۵۰۳ | Redis یا DB وصل نیست | `REDIS_URL` (با پسورد) و `DATABASE_URL`؛ لاگ اتصال |
| صفحهٔ وب ۴۰۴ می‌دهد | fallback به `index.html` فعال نیست | تنظیمات Static/nginx |
| OTP نمی‌آید | Limo | `LIMO_*` و الگوی پیامک؛ لاگ worker/API |
| سند حسابداری ثبت نمی‌شود | Worker خاموش است | سرویس worker را روشن/ری‌استارت کنید؛ لاگ outbox |
| فایل آپلود نمی‌شود | MinIO/باکت | `S3_*` و وجود باکت `saman-files` |

---

## ۱۴) امنیت در این استقرار (چک‌لیست)

- [ ] `JWT_ACCESS_SECRET`, `OTP_PEPPER`, `REFRESH_PEPPER`, `APP_ENCRYPTION_KEY` تصادفی و فقط در env چابکان (نه در ریپو).
- [ ] `DOCS_ENABLED=false`, `LOG_BODIES=false`, `COOKIE_SECURE=true`, `RATE_LIMIT_ENABLED=true`.
- [ ] دامنهٔ API و وب فقط HTTPS (redirect روشن).
- [ ] MinIO: باکت خصوصی؛ کلیدها فقط در env.
- [ ] ورود ادمین با OTP؛ ساخت کاربر دوم برای تأیید اسناد (تفکیک وظایف).
- [ ] بکاپ خودکار PostgreSQL فعال و یک بار **بازیابی آزمایشی** انجام شده.
- [ ] در حالت Managed DB، بدانید که نقش‌های حداقلی `saman_app/saman_worker` ساخته نمی‌شوند؛ برای تولید حساس، PostgreSQL اختصاصی با نقش‌های جدا توصیه می‌شود.

---

## ۱۵) چه چیزی هنوز روی چابکان تست نشده؟

صادقانه: در محیط توسعهٔ ما **Docker نصب نبود**، بنابراین `docker build` و استقرار واقعی روی چابکان توسط ما اجرا نشده است.
آنچه تست شده: مایگریشن در حالت Managed، بوت API با `APP_ENV=production` + `DB_MANAGED=true` (سلامت `live=200`)، seed، چرخهٔ کامل سفارش تا سند حسابداری، و ScopeGuard/Step-Up روی PostgreSQL محلی.
اولین استقرار را با همین سند انجام دهید؛ اگر جایی خطا داد، لاگ سرویس را بفرستید تا دقیقاً همان را رفع کنیم.

---

## پیوست: فایل‌های آماده در ریپو

- [`deploy/chabakan/env.api.example`](../../deploy/chabakan/env.api.example)
- [`deploy/chabakan/env.worker.example`](../../deploy/chabakan/env.worker.example)
- [`infra/docker/api.Dockerfile`](../../infra/docker/api.Dockerfile) — ایمیج مشترک API/Worker
- [`infra/docker/entrypoint.sh`](../../infra/docker/entrypoint.sh) — سوییچ `APP_ROLE`
- [`docs/06-deployment/INSTALL-FA.md`](INSTALL-FA.md) — راهنمای عمومی نصب (Docker Compose)
