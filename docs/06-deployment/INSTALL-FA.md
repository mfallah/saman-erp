# ۰۶ — راهنمای نصب و راه‌اندازی تولیدی «سامان ERP»

> **برای چه کسی:** مدیر سرور / تیم فنی کرکسی‌شاپ که می‌خواهد کل سامانه (API، Worker، پنل وب فارسی، PostgreSQL، Redis، MinIO و بکاپ) را با Docker روی سرور خودش راه‌اندازی کند.
> **زمان لازم:** ۴۵ تا ۹۰ دقیقه برای نصب اولین بار (بدون احتساب دانلود ایمیج‌ها و انتظار برای صدور گواهی TLS).
> **پیش‌نیاز دانش:** آشنایی مقدماتی با Linux، SSH و ویرایش فایل متنی. هر دستور کامل و قابل کپی است.
>
> **دامنهٔ هدف این سند:** `https://erp.carexy.shop` (سامانهٔ دوم کرکسی‌شاپ). سایت عمومی فروشگاه `https://carexy.shop` است و API کرکسی‌شاپ در `https://carexy.shop` با هدر `X-API-KEY` قرار دارد.
>
> **وضعیت صحت‌سنجی (صادقانه):** در محیط ساخت و بازبینی این نسخه **Docker در دسترس نبود**. مراحل این سند با بازبینی دقیق در برابر `docs/01-architecture/ARCHITECTURE.md`، `docs/adr/0012-deployment.md`، فایل قراردادی `.env.example` و قرارداد `docker-compose.yml` نوشته شده‌اند، اما **اجرای واقعی آن‌ها (`docker compose config` و `docker compose up`) هنوز انجام نشده است**. اولین نصب روی سرور واقعی باید نتیجه‌اش در بخش ۱۸.۲ ثبت و در صورت تفاوت، سند اصلاح شود. هیچ ادعای «تست‌شده» در این سند وجود ندارد.

---

## فهرست

1. [معماری استقرار و تصمیم‌های کلیدی](#۱-معماری-استقرار-و-تصمیمهای-کلیدی)
2. [انتخاب اندازهٔ سرور](#۲-انتخاب-اندازهٔ-سرور)
3. [آماده‌سازی سرور Ubuntu](#۳-آمادهسازی-سرور-ubuntu)
4. [نصب Docker Engine و Compose](#۴-نصب-docker-engine-و-compose)
5. [ساخت کاربر سرویس و مسیر پروژه](#۵-ساخت-کاربر-سرویس-و-مسیر-پروژه)
6. [ساخت و توضیح فایل `.env`](#۶-ساخت-و-توضیح-فایل-env)
7. [راه‌اندازی اولیه و بررسی سلامت زیرساخت](#۷-راهاندازی-اولیه-و-بررسی-سلامت-زیرساخت)
8. [گزینهٔ الف — PostgreSQL داخل Compose (پیشنهادی)](#۸-گزینهٔ-الف--postgresql-داخل-compose-پیشنهادی)
9. [گزینهٔ ب — PostgreSQL خارجی یا مدیریت‌شده](#۹-گزینهٔ-ب--postgresql-خارجی-یا-مدیریتشده)
10. [مهاجرت دیتابیس، Seed و ساخت اولین مدیر](#۱۰-مهاجرت-دیتابیس-seed-و-ساخت-اولین-مدیر)
11. [راه‌اندازی سرویس‌ها و رسیدن به صفحهٔ ورود فارسی](#۱۱-راهاندازی-سرویسها-و-رسیدن-به-صفحهٔ-ورود-فارسی)
12. [TLS — گزینهٔ الف: Caddy داخلی / گزینهٔ ب: nginx موجود](#۱۲-tls--گزینهٔ-الف-caddy-داخلی--گزینهٔ-ب-nginx-موجود)
13. [فایروال، سخت‌سازی SSH و امنیت میزبان](#۱۳-فایروال-سختسازی-ssh-و-امنیت-میزبان)
14. [بکاپ‌گیری خودکار و آموزش بازیابی](#۱۴-بکاپگیری-خودکار-و-آموزش-بازیابی)
15. [ارتقا و برگشت (Upgrade / Rollback)](#۱۵-ارتقا-و-برگشت-upgrade--rollback)
16. [لاگ، متریک و پایش](#۱۶-لاگ-متریک-و-پایش)
17. [عیب‌یابی](#۱۷-عیبیابی)
18. [چک‌لیست امنیتی نهایی و ثبت نتیجهٔ نصب](#۱۸-چکلیست-امنیتی-نهایی-و-ثبت-نتیجهٔ-نصب)
- [پیوست: نمونهٔ کامل `.env`](#پیوست-نمونهٔ-کامل-env)

---

## ۱. معماری استقرار و تصمیم‌های کلیدی

در یک سرور واحد، این سرویس‌ها اجرا می‌شوند (`ADR-0012`):

| سرویس | ایمیج | نقش | دسترسی از بیرون |
|---|---|---|---|
| `postgres` | `postgres:16-alpine` | دیتابیس اصلی، دیتابیس `saman`، schema `erp` | ندارد (فقط شبکهٔ داخلی Docker) |
| `redis` | `redis:7-alpine` | کش، صف BullMQ، rate limit | ندارد |
| `minio` | `minio/minio` | ذخیره‌سازی سازگار با S3: فایل، برچسب، بکاپ | کنسول فقط روی `127.0.0.1:9001` |
| `minio-init` | `minio/mc` | ساخت باکت‌های `saman-files` و `saman-backups`، کاربر برنامه (یک‌باره) | ندارد |
| `api` | `saman-erp/api:$IMAGE_TAG` | HTTP API بی‌حالت (NestJS + Fastify) روی پورت داخلی **۴۰۰۰** | ندارد؛ فقط از طریق `web`/Caddy |
| `worker` | همان ایمیج API | outbox، صف‌ها، زمان‌بندی، پارتیشن‌ها | ندارد |
| `web` | `saman-erp/web:$IMAGE_TAG` (nginx) | سرو SPA فارسی/RTL + پروکسی `/api` و `/health` به `api:4000` | فقط `127.0.0.1:${WEB_HOST_PORT}` در حالت nginx میزبان |
| `caddy` (پروفایل `tls`) | `caddy:2-alpine` | خاتمهٔ TLS خودکار Let's Encrypt | `80` و `443` |
| `backup` (پروفایل `backup`) | `saman-erp/backup:$IMAGE_TAG` | `pg_dump` طبق کران، رمزگذاری GPG، آپلود | ندارد |

**چرا این معماری؟** `ARCHITECTURE.md §3` و `ADR-0001` یک «مونولیت ماژولار» با دو پردازهٔ `api` و `worker` انتخاب کرده‌اند تا تراکنش‌های فروش → موجودی → سند حسابداری اتمیک باشند. یک سرور برای ۱۰٬۰۰۰ کالا و تراکنش روزانهٔ بالا کافی است و پیچیدگی Kubernetes/Kafka را تحمیل نمی‌کند. تنها نقطهٔ شکست، خود سرور است؛ برای همین بکاپ و تمرین بازیابی اجباری است (بخش ۱۴).

**قرارداد فایل‌های زیرساخت** (توسط تیم پلتفرم در مخزن قرار می‌گیرد؛ این سند مصرف‌کنندهٔ آن است):

```text
docker-compose.yml                     # استک پایهٔ تولیدی (۱۰ سرویس؛ پروفایل‌های tools/tls/backup/observability)
docker-compose.prod.yml                # لایهٔ سخت‌سازی تولید (restart always، pull_policy، رزرو منابع)
docker-compose.dev.yml                 # لایهٔ توسعهٔ محلی (پورت‌های loopback، hot-reload)
.env.example                           # منبع رسمی نام و معنای متغیرها (بدون مقدار حساس)
scripts/gen-secrets.sh                 # ساخت .env و پوشهٔ secrets/ (رمزهای crown)
infra/docker/postgres/init/01-init.sql # نقش‌ها، schema، extension هنگام اولین راه‌اندازی
infra/docker/postgres/postgresql.conf  # tuning دیتابیس (۸ vCPU / 16 GB)
infra/docker/postgres/pg_hba.conf      # قواعد احراز هویت دیتابیس (hba_file صریح)
infra/docker/minio-init.sh             # باکت‌ها/versioning/کاربر کم‌دسترسی MinIO
infra/nginx/nginx.conf + saman.conf    # nginx غیر root برای SPA و پروکسی /api
infra/nginx/Caddyfile                  # پیکربندی Caddy برای پروفایل tls
infra/backup/                          # Dockerfile + backup.sh/restore.sh
infra/observability/                   # Prometheus/Alerts/Grafana (پروفایل observability)
```

> **قرارداد پورت‌ها:** داخل شبکهٔ Docker، API روی `4000` گوش می‌دهد (`APP_PORT=4000`)، nginx وب روی `8080`، و nginx وب درخواست‌های `/api` و `/health` را به `http://api:4000` پروکسی می‌کند. روی میزبان فقط `WEB_HOST_PORT` (پیش‌فرض `8080`) و در حالت Caddy پورت‌های `80`/`443` باز می‌شوند. `API_HOST_PORT` برای bind اختیاری API روی میزبان است و در تولید نباید باز باشد.

> اگر `docker-compose.yml` در مخزن موجود نبود، نصب را متوقف کنید؛ این راهنما فقط با Compose قراردادی بالا کار می‌کند. (نویسندهٔ این سند مالک `infra/` نیست و آن را پس از تحویل توسط تیم پلتفرم بازبینی می‌کند.)

---

## ۲. انتخاب اندازهٔ سرور

### ۲.۱ جدول اندازه‌گذاری

| سناریو | vCPU | RAM | دیسک | توضیح |
|---|---|---|---|---|
| تست/نمایش (غیرتولیدی) | ۲ | ۴ GB | ۴۰ GB SSD | بیلد Docker کند است؛ مناسب داده واقعی نیست |
| **حداقل تولیدی برای ۱۰٬۰۰۰ کالا و ~۵٬۰۰۰ سفارش/روز** | **۴** | **۸ GB** | **۱۲۰ GB NVMe** | مطابق هدف `G6` در `docs/00-overview` |
| **پیشنهادی برای اوج تراکنش و رشد ۲–۳ ساله** | **۸** | **۱۶–۳۲ GB** | **۲۵۰–۵۰۰ GB NVMe** | امکان `api`×۲ و `worker`×۲ |
| پروفایل HA (خارج از دامنهٔ v1) | ۲ سرور | ۱۶ GB هرکدام | NVMe + ذخیره‌سازی مشترک | در `docs/09-roadmap` |

### ۲.۲ محاسبهٔ فضای دیسک (چرا ۱۲۰ GB حداقل است؟)

- هدف طراحی: ۲۰۰٬۰۰۰ تا ۲٬۰۰۰٬۰۰۰ ردیف دفتر موجودی در روز (`docs/00-overview/README.md §3`).
- در بار واقعی ۱۰k کالا: حدود ۲۰۰٬۰۰۰ ردیف/روز × ~۳۰۰ بایت (ردیف + ایندکس) ≈ ۶۰ MB/روز ≈ **۱٫۸ GB در ماه** فقط برای `inventory_transactions`.
- علاوه بر آن: `audit_logs` (نگهداری ۷ ساله — آرشیو Offsite)، `api_request_logs`، `outbox_events`، `channel_api_calls`، WAL و بکاپ‌های محلی موقت.
- برآورد محافظه‌کارانه: **~۲۵–۴۰ GB رشد سالانهٔ دیتابیس** + فضای آزاد ۲۰٪ برای VACUUM و بازسازی ایندکس + فضای موقت بکاپ.
- دیسک محلی باید حداقل **۲ برابر حجم فعلی دیتابیس** فضای آزاد داشته باشد؛ آرشیو لاگ‌ها و بکاپ‌ها Offsite می‌روند.

> اگر دیسک SSD معمولی (نه NVMe) است، برای TPS بالا NVMe توصیه می‌شود؛ PostgreSQL به IOPS تصادفی حساس است.

### ۲.۳ پیش‌نیازهای شبکه

| مورد | مقدار |
|---|---|
| IPv4 عمومی ثابت | لازم (برای دامنه و TLS) |
| رکورد DNS | `A erp.carexy.shop → <IP سرور>` (قبل از بخش ۱۲ حتماً تنظیم شود) |
| پورت‌های ورودی | `22/tcp` (فقط از IP مدیر)، `80/tcp`، `443/tcp` |
| خروجی | `443/tcp` به `carexy.shop`، API دیجی‌کالا، Limo SMS (`api.limosms.com`) و مقصد Offsite؛ `123/udp` برای NTP |
| منطقهٔ زمانی | `Asia/Tehran` (ذخیره‌سازی UTC است؛ نمایش شمسی و RTL در UI) |

---

## ۳. آماده‌سازی سرور Ubuntu

روی **Ubuntu 22.04 LTS یا 24.04 LTS** (۶۴ بیتی، x86_64 یا arm64). همهٔ دستورها با کاربر `root` یا `sudo` اجرا می‌شوند.

### ۳.۱ به‌روزرسانی و بسته‌های پایه

```bash
sudo apt-get update
sudo apt-get -y upgrade
sudo apt-get install -y ca-certificates curl gnupg git ufw fail2ban unattended-upgrades htop jq unzip openssl gnupg2 chrony
```

**چرا:** `ca-certificates` برای TLS، `gnupg` برای مخزن Docker و رمزگذاری بکاپ، `chrony` برای همگام‌سازی ساعت (توکن JWT، OTP و امضای Webhook به ساعت دقیق وابسته‌اند)، `fail2ban` برای SSH.

### ۳.۲ منطقهٔ زمانی و همگام‌سازی ساعت

```bash
sudo timedatectl set-timezone Asia/Tehran
sudo systemctl enable --now systemd-timesyncd
timedatectl status
```

خروجی باید `System clock synchronized: yes` داشته باشد. **چرا:** OTP دو دقیقه‌ای، انقضای JWT و پنجرهٔ ۵ دقیقه‌ای Webhook با اختلاف ساعت خراب می‌شوند.

### ۳.۳ فایل Swap (برای جلوگیری از OOM ناگهانی)

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

روی سرور ۸ GB، Swap = ۴ GB؛ روی ۱۶ GB، Swap = ۴–۸ GB. **چرا:** بارگذاری گزارش‌های سنگین یا بیلد اولیه ممکن است حافظه را موقتاً بالا ببرد؛ Swap از kill شدن `postgres` جلوگیری می‌کند.

### ۳.۴ محدودیت‌های سیستم و لاگ

```bash
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-saman.conf
echo 'net.core.somaxconn=4096' | sudo tee -a /etc/sysctl.d/99-saman.conf
sudo sysctl --system

echo '* soft nofile 65535' | sudo tee /etc/security/limits.d/99-saman.conf
echo '* hard nofile 65535' | sudo tee -a /etc/security/limits.d/99-saman.conf

sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=2G\n' | sudo tee /etc/systemd/journald.conf.d/99-saman.conf
sudo systemctl restart systemd-journald
```

**چرا:** Docker و اتصال‌های زیاد DB نیاز به file descriptor بالا دارند؛ محدودکردن journald از پر شدن دیسک توسط لاگ سیستم جلوگیری می‌کند.

### ۳.۵ به‌روزرسانی امنیتی خودکار

```bash
sudo dpkg-reconfigure -plow unattended-upgrades    # گزینه Yes
```

---

## ۴. نصب Docker Engine و Compose

روش رسمی Docker برای Ubuntu (نه `docker.io` مخزن Ubuntu که قدیمی است).

### ۴.۱ افزودن مخزن رسمی Docker

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
```

### ۴.۲ نصب و فعال‌سازی

```bash
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker run --rm hello-world
sudo docker compose version
```

خروجی `hello-world` یعنی Docker درست نصب شده است. نسخهٔ Compose باید **v2.20 یا بالاتر** باشد (برای پروفایل‌ها و `depends_on: condition`).

### ۴.۳ پیکربندی پایدار Docker daemon

```bash
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json > /dev/null <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" },
  "live-restore": true,
  "default-address-pools": [
    { "base": "10.201.0.0/16", "size": 24 }
  ]
}
EOF
sudo systemctl restart docker
sudo docker info --format '{{.Driver}} {{.LoggingDriver}}'
```

**چرا:**
- `log-opts`: هر کانتینر حداکثر ۱۰۰ MB لاگ نگه می‌دارد؛ بدون آن دیسک پر می‌شود (سناریوی رایج حادثه).
- `live-restore`: با restart شدن daemon، کانتینرها زنده می‌مانند.
- `default-address-pools`: جلوگیری از تداخل شبکهٔ Docker با شبکهٔ داخلی شرکت یا VPN (مثلاً `172.17.0.0/16`).

> اگر شبکهٔ شرکت از `10.201.0.0/16` استفاده می‌کند، این بازه را به بازهٔ آزاد دیگری تغییر دهید.

---

## ۵. ساخت کاربر سرویس و مسیر پروژه

**چرا کاربر جدا؟** سرویس نباید با `root` اجرا شود؛ کاربر `saman` فقط به داکر و پوشهٔ پروژه دسترسی دارد.

```bash
sudo adduser --disabled-password --gecos "" saman
sudo usermod -aG docker saman
sudo mkdir -p /opt/saman-erp
sudo chown saman:saman /opt/saman-erp
```

**ورود به کاربر سرویس و دریافت کد:**

```bash
sudo -iu saman
cd /opt/saman-erp
git clone https://github.com/mfallah/saman-erp.git .
git fetch --tags
git checkout v1.0.0        # همیشه یک تگ/کامیت مشخص، نه branch شناور
git log -1 --oneline
```

> اگر سرور به GitHub دسترسی ندارد، آرشیو انتشار (tarball) را از تیم تحویل بگیرید، در `/opt/saman-erp` باز کنید و مطمئن شوید `docker-compose.yml` و `.env.example` در ریشه قرار دارند. کنترل نسخه برای ارتقای بخش ۱۵ ضروری است.

---

## ۶. ساخت و توضیح فایل `.env`

**منبع رسمی نام متغیرها:** فایل `.env.example` در ریشهٔ مخزن. این سند همهٔ آن‌ها را توضیح می‌دهد؛ اگر فایل تغییر کرد، سند هم باید هم‌زمان به‌روز شود. هیچ متغیر خارج از آن فایل در این سند استفاده نمی‌شود.

### ۶.۱ ساخت فایل و تعیین دسترسی

```bash
cd /opt/saman-erp
./scripts/gen-secrets.sh          # می‌سازد: .env (mode 600) و ./secrets/ (mode 700)
ls -l .env secrets/
```

**چرا `gen-secrets.sh` و نه `cp` ساده؟** کلیدهای تاج (JWT، کلید رمزنگاری، pepperهای OTP/Refresh، رمز دیتابیس/Redis و URL مهاجرت) نباید در file محیطی Compose دیده شوند. اسکریپت آن‌ها را در `./secrets/` (git-ignored، فایل‌ها mode `400`) می‌سازد؛ Compose آن‌ها را به‌صورت فایل در `/run/secrets/<name>` mount می‌کند و برنامه با متغیرهای `*_FILE` می‌خواند. `secrets/` باید مالک/قابل‌خواندنِ uid‌های کانتینر باشد: `1000:1000` برای api/worker/migrate و `1000:1000` برای رمز بکاپ (اسکریپت وقتی با root اجرا شود این کار را خودکار انجام می‌دهد).

> **مسیر دستی (فقط اگر `gen-secrets.sh` را اجرا نمی‌کنید):** `cp .env.example .env && chmod 600 .env`، سپس `mkdir -p secrets && chmod 700 secrets` و هشت فایل `secrets/{jwt_access_secret,app_encryption_key,otp_pepper,refresh_pepper,db_password,migration_db_url,redis_password,backup_encryption_passphrase}` را با `chmod 400` بسازید. بدون این فایل‌ها `docker compose up` با خطای missing secret متوقف می‌شود.

> **هرگز** فایل `.env` را در Git قرار ندهید؛ `.gitignore` مخزن قبلاً آن را نادیده می‌گیرد. از آن بکاپ رمزگذاری‌شده بگیرید (بخش ۱۴.۴).

### ۶.۲ تولید رمزها و کلیدهای قوی

**قاعده:** رمزهای دیتابیس/Redis/MinIO به‌صورت hex ساخته می‌شوند تا هیچ کاراکتری نیاز به URL-encode نداشته باشد و `DATABASE_URL`/`MIGRATION_DATABASE_URL` بی‌ابهام بماند.

```bash
openssl rand -hex 32     # رمز دیتابیس (۶۴ کاراکتر hex)
openssl rand -hex 32     # رمز Redis
openssl rand -hex 32     # رمز MinIO
openssl rand -base64 48  # JWT_ACCESS_SECRET
openssl rand -base64 32  # APP_ENCRYPTION_KEY (۳۲ بایت base64، مطابق .env.example)
openssl rand -hex 32     # OTP_PEPPER  (crown secret; in ./secrets/otp_pepper)
openssl rand -hex 32     # REFRESH_PEPPER (crown secret; in ./secrets/refresh_pepper)
openssl rand -base64 24  # BOOTSTRAP_ADMIN_PASSWORD (حداقل ۱۲ کاراکتر)
openssl rand -base64 32  # BACKUP_ENCRYPTION_PASSPHRASE
```

هر دستور را یک‌بار اجرا کنید و خروجی را در `.env` بگذارید؛ برای `JWT_ACCESS_SECRET` یک اجرا کافی است (Refresh Token تصادفی و hash‌شده است و کلید JWT جدا ندارد؛ `ADR-0004`).

> ⚠️ `APP_ENCRYPTION_KEY` کلید AES-256-GCM برای رمزنگاری اعتبارنامهٔ کانال‌ها است. **گم شدن یا تغییر بدون چرخش کنترل‌شده یعنی از دست رفتن اعتبارنامه‌های رمزنگاری‌شده** (رویهٔ چرخش در `RUNBOOK.md §8`). از آن بکاپ امن و آفلاین بگیرید.
>
> `BACKUP_ENCRYPTION_PASSPHRASE` رمز متقارن GPG بکاپ است. اگر آن را گم کنید، بکاپ‌ها قابل بازیابی نیستند؛ آن را جدا از سرور و در گاوصندوق نگه دارید.

### ۶.۳ جدول کامل متغیرهای `.env.example`

#### الف) برنامه و رابط

| متغیر | الزامی | حساس؟ | توضیح | مقدار تولیدی |
|---|---|---|---|---|
| `APP_ENV` | بله | خیر | محیط؛ `production` رفتار امن (docs خاموش، cookie امن) را فعال می‌کند | `production` |
| `APP_NAME` | بله | خیر | نام نمایشی برنامه | `Saman ERP` |
| `APP_PORT` | بله | خیر | پورت داخلی API در کانتینر؛ **با nginx و healthcheck هم‌تراز است، تغییر ندهید** | `4000` |
| `APP_URL` | بله | خیر | آدرس عمومی HTTPS (بدون `/` انتهایی)؛ برای لینک پیامک، Webhook و redirect | `https://erp.carexy.shop` |
| `API_PREFIX` | بله | خیر | پیشوند مسیر API | `api` |
| `API_VERSION` | بله | خیر | نسخهٔ URI | `v1` |
| `APP_TIMEZONE` | بله | خیر | منطقهٔ زمانی کسب‌وکار | `Asia/Tehran` |
| `APP_DEFAULT_LOCALE` | بله | خیر | زبان پیش‌فرض UI (فارسی/RTL) | `fa-IR` |
| `DOCS_ENABLED` | بله | خیر | OpenAPI UI در production خاموش باشد | `false` |
| `LOG_LEVEL` | بله | خیر | سطح لاگ pino | `info` |

#### ب) امنیت و نشست

| متغیر | الزامی | حساس؟ | توضیح | مقدار تولیدی |
|---|---|---|---|---|
| `JWT_ACCESS_SECRET` | بله | **بله** | امضای Access Token | `openssl rand -base64 48` |
| `JWT_ACCESS_TTL` | بله | خیر | عمر توکن دسترسی | `10m` |
| `JWT_REFRESH_TTL` | بله | خیر | عمر Refresh Token | `7d` |
| `APP_ENCRYPTION_KEY` | بله | **بله، حیاتی** | AES-256-GCM برای اعتبارنامهٔ کانال‌ها؛ ۳۲ بایت base64 | `openssl rand -base64 32` |
| `APP_ENCRYPTION_KEY_VERSION` | بله | خیر | نسخهٔ کلید (برای چرخش) | `1` |
| `CORS_ORIGINS` | بله | خیر | Originهای مجاز، کاماجدا و دقیق (با scheme) | `https://erp.carexy.shop` |
| `COOKIE_SECURE` | بله | خیر | در تولید با HTTPS حتماً `true` | `true` |
| `COOKIE_DOMAIN` | خیر | خیر | خالی = کوکی host-only (امن‌تر) | خالی |
| `TRUST_PROXY` | بله | خیر | پشت nginx/Caddy باید `true` باشد تا IP واقعی در rate limit و audit ثبت شود | `true` |
| `SECURITY_HSTS` | بله | خیر | فعال‌سازی HSTS بعد از اطمینان از HTTPS | `true` |
| `RATE_LIMIT_ENABLED` | بله | خیر | محدودیت نرخ فعال | `true` |
| `RATE_LIMIT_AUTH_PER_MIN` | بله | خیر | سقف تلاش ورود/OTP هر IP در دقیقه | `10` |
| `RATE_LIMIT_OTP_PER_HOUR` | بله | خیر | سقف ارسال OTP هر موبایل در ساعت | `5` |
| `RATE_LIMIT_API_PER_MIN` | بله | خیر | سقف درخواست API هر IP در دقیقه | `300` |
| `LOGIN_MAX_FAILED` | بله | خیر | تعداد خطای ورود قبل از قفل حساب | `10` |
| `LOGIN_LOCK_MINUTES` | بله | خیر | مدت قفل حساب | `15` |

#### ج) دیتابیس

| متغیر | الزامی | حساس؟ | توضیح | مقدار تولیدی |
|---|---|---|---|---|
| `DATABASE_URL` | بله | **بله** | اتصال **نقش برنامه `saman_app`** (بدون DDL). در حالت کانتینر: `postgres://saman_app:<db-hex>@postgres:5432/saman` | طبق توضیح |
| `MIGRATION_DATABASE_URL` | بله | **بله** | اتصال **نقش مهاجرت `saman_migrator`** (DDL/مالک schema)؛ فقط `db:migrate`/`db:seed` | `postgres://saman_migrator:<db-hex>@postgres:5432/saman` |
| `DB_SSL` | فقط DB خارجی با TLS | خیر | فعال‌سازی TLS اتصال دیتابیس | `false` (داخلی) / `true` (خارجی) |
| `DB_SSL_CA_PATH` | فقط DB خارجی با TLS | خیر | مسیر CA داخل کانتینر (باید mount شود) | `/run/secrets/db-ca.pem` |
| `DB_POOL_MAX` | بله | خیر | حداکثر اتصال هر پردازه؛ برای ۴ vCPU مقدار ۲۰ | `20` |
| `DB_STATEMENT_TIMEOUT_MS` | بله | خیر | سقف زمان هر query در API (worker مقدار بلندتر خودش را دارد) | `5000` |
| `DB_IDLE_TIMEOUT_MS` | بله | خیر | بستن اتصال بی‌کار | `30000` |
| `DB_MIGRATION_ROLE` | بله | خیر | نام نقش مهاجرت؛ برای تأیید در boot/CLI | `saman_migrator` |
| `DB_SCHEMA` | بله | خیر | schema کسب‌وکار | `erp` |

#### د) Redis

| متغیر | الزامی | حساس؟ | توضیح | مقدار تولیدی |
|---|---|---|---|---|
| `REDIS_URL` | بله | **بله** | آدرس Redis؛ در تولید با رمز: `redis://:<redis-hex>@redis:6379/0` | طبق توضیح |
| `REDIS_PASSWORD` | در تولید بله | **بله** | رمز Redis (Compose آن را در redis اعمال می‌کند) | `openssl rand -hex 32` |
| `REDIS_PREFIX` | بله | خیر | پیشوند کلیدها (برای چند محیط روی یک Redis) | `saman:` |
| `REDIS_TLS` | خیر | خیر | TLS برای Redis مدیریت‌شده | `false` |

#### ه) ذخیره‌سازی S3 / MinIO

| متغیر | الزامی | حساس؟ | توضیح | مقدار تولیدی |
|---|---|---|---|---|
| `S3_ENDPOINT` | بله | خیر | آدرس S3/MinIO | `http://minio:9000` |
| `S3_REGION` | بله | خیر | منطقه | `us-east-1` |
| `S3_BUCKET` | بله | خیر | باکت فایل‌های برنامه (توسط `minio-init` ساخته می‌شود) | `saman-files` |
| `S3_ACCESS_KEY` | بله | **بله** | Access Key کاربر برنامه | `saman-app` |
| `S3_SECRET_KEY` | بله | **بله** | Secret Key کاربر برنامه | `openssl rand -hex 32` |
| `S3_FORCE_PATH_STYLE` | بله | خیر | برای MinIO باید `true` | `true` |
| `S3_PUBLIC_BASE_URL` | خیر | خیر | base عمومی/CDN برای مدیا (در v1 خالی) | خالی |
| `UPLOAD_MAX_MB` | بله | خیر | سقف حجم آپلود | `20` |

#### و) SMS (Limo)

| متغیر | الزامی | حساس؟ | توضیح | مقدار تولیدی |
|---|---|---|---|---|
| `SMS_MODE` | بله | خیر | `mock` (فقط لاگ — توسعه) یا `limo` (ارسال واقعی — تولید) | `limo` |
| `LIMO_BASE_URL` | بله در `limo` | خیر | آدرس API لیمو | `https://api.limosms.com` |
| `LIMO_API_KEY` | بله در `limo` | **بله** | کلید API از پنل لیمو | از پنل |
| `LIMO_SENDER` | بله در `limo` | خیر | شمارهٔ خط ارسال | از پنل |
| `LIMO_OTP_PATTERN_ID` | خیر | خیر | شناسهٔ pattern پیامک OTP | از پنل |
| `OTP_TTL_SECONDS` | بله | خیر | عمر OTP | `120` |
| `OTP_MAX_ATTEMPTS` | بله | خیر | سقف تلاش تأیید OTP | `5` |
| `OTP_PEPPER` | بله (در تولید از `OTP_PEPPER_FILE`) | **بله** | pepper هش کد OTP؛ در `./secrets/otp_pepper` | `openssl rand -hex 32` |
| `REFRESH_PEPPER` | بله (در تولید از `REFRESH_PEPPER_FILE`) | **بله** | pepper هش Refresh Token؛ در `./secrets/refresh_pepper` | `openssl rand -hex 32` |

#### ز) کانال‌ها

| متغیر | الزامی | حساس؟ | توضیح | مقدار تولیدی |
|---|---|---|---|---|
| `CAREXY_API_BASE_URL` | بله | خیر | آدرس API فروشگاه کرکسی‌شاپ | `https://carexy.shop` |
| `CAREXY_API_KEY` | بله | **بله** | کلید `X-API-KEY` از پنل کرکسی‌شاپ | از پنل |
| `CAREXY_WEBHOOK_SECRET` | بله | **بله** | راز امضای Webhook کرکسی‌شاپ | `openssl rand -hex 32` |
| `DIGIKALA_API_BASE_URL` | بله | خیر | آدرس Open API دیجی‌کالا | `https://seller.digikala.com/open-api/v1` |
| `DIGIKALA_CLIENT_ID` | در صورت فعال بودن دیجی‌کالا | خیر | OAuth2 Client ID | از پنل فروشنده |
| `DIGIKALA_CLIENT_SECRET` | در صورت فعال بودن دیجی‌کالا | **بله** | OAuth2 Client Secret | از پنل فروشنده |
| `DIGIKALA_WEBHOOK_SECRET` | بله | **بله** | راز امضای Webhook دیجی‌کالا | `openssl rand -hex 32` |
| `CHANNEL_SYNC_ENABLED` | بله | خیر | فعال‌سازی همگام‌سازی کانال‌ها | `true` |
| `CHANNEL_STOCK_DEBOUNCE_MS` | بله | خیر | تأخیر debounce ارسال موجودی | `3000` |
| `CHANNEL_HTTP_TIMEOUT_MS` | بله | خیر | timeout فراخوانی کانال | `15000` |

#### ح) صف و Worker

| متغیر | الزامی | حساس؟ | توضیح | مقدار تولیدی |
|---|---|---|---|---|
| `WORKER_CONCURRENCY` | بله | خیر | هم‌روندی پردازش job | `10` |
| `OUTBOX_BATCH_SIZE` | بله | خیر | اندازهٔ batch outbox | `100` |
| `OUTBOX_POLL_INTERVAL_MS` | بله | خیر | فاصلهٔ polling outbox | `1000` |

#### ط) مشاهده‌پذیری

| متغیر | الزامی | حساس؟ | توضیح | مقدار تولیدی |
|---|---|---|---|---|
| `METRICS_ENABLED` | بله | خیر | endpoint `/metrics` | `true` |
| `OTEL_ENABLED` | بله | خیر | تریس OpenTelemetry | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | در صورت `OTEL_ENABLED=true` | خیر | آدرس Collector | خالی / آدرس داخلی |
| `SENTRY_DSN` | خیر | **بله (نشانی حساس)** | DSN برای خطاها | خالی |

#### ی) بکاپ

| متغیر | الزامی | حساس؟ | توضیح | مقدار تولیدی |
|---|---|---|---|---|
| `BACKUP_ENABLED` | بله | خیر | فعال بودن بکاپ خودکار | `true` |
| `BACKUP_CRON` | بله | خیر | زمان‌بندی cron (در سرویس sidecar) | `0 2 * * *` |
| `BACKUP_KEEP_DAYS` | بله | خیر | نگهداری بکاپ روزانه (روز) | `30` |
| `BACKUP_S3_PREFIX` | بله | خیر | پیشوند مسیر در باکت بکاپ | `backups/postgres` |
| `BACKUP_ENCRYPTION_PASSPHRASE` | بله در تولید | **بله، حیاتی** | رمز متقارن GPG (AES-256) برای بکاپ؛ فقط برای اسکریپت backup | `openssl rand -base64 32` |
| `BACKUP_MIRROR_S3_ENDPOINT` | خیر | خیر | مقصد Offsite (provider/account دوم) | خالی |
| `BACKUP_MIRROR_S3_BUCKET` | خیر | خیر | باکت Offsite | خالی |
| `BACKUP_MIRROR_S3_ACCESS_KEY` | خیر | **بله** | کلید Offsite | خالی |
| `BACKUP_MIRROR_S3_SECRET_KEY` | خیر | **بله** | Secret Offsite | خالی |

#### ک) Bootstrap (فقط اولین اجرا؛ بعد از آن حذف شود)

`pnpm db:seed` **idempotent** است و فقط وقتی جدول `users` خالی باشد مدیر اول را با این مقادیر می‌سازد (`ADR-0008`).

| متغیر | الزامی | حساس؟ | توضیح |
|---|---|---|---|
| `BOOTSTRAP_ADMIN_MOBILE` | فقط اولین seed | خیر | موبایل مدیر اول، مثلاً `09121234567` |
| `BOOTSTRAP_ADMIN_PASSWORD` | فقط اولین seed | **بله** | رمز اولیه (حداقل ۱۲ کاراکتر)؛ اولین ورود تغییر دهید |
| `BOOTSTRAP_ORG_NAME` | فقط اولین seed | خیر | نام سازمان اولیه | `کرکسی شاپ` |

#### ل) متغیرهای پیکربندی Compose (توسط Docker Compose خوانده می‌شوند)

| متغیر | الزامی | حساس؟ | توضیح | مقدار نمونه |
|---|---|---|---|---|
| `POSTGRES_USER` | بله | خیر | کاربر سوپریوزر کانتینر دیتابیس (نقش مدیر) | `saman` |
| `POSTGRES_PASSWORD` | بله | **بله** | رمز آن کاربر؛ **مبنای رمز اولیهٔ نقش‌های برنامه** (بخش ۸.۲) | `openssl rand -hex 32` |
| `POSTGRES_DB` | بله | خیر | نام دیتابیس | `saman` |
| `POSTGRES_PORT` | بله | خیر | پورت داخلی دیتابیس | `5432` |
| `REDIS_PORT` | بله | خیر | پورت داخلی Redis | `6379` |
| `MINIO_ROOT_USER` | بله | خیر | کاربر مدیر MinIO (فقط init/کنسول) | `saman` |
| `MINIO_ROOT_PASSWORD` | بله | **بله** | رمز مدیر MinIO | `openssl rand -hex 32` |
| `API_HOST_PORT` | بله | خیر | پورت اختیاری API روی میزبان؛ در تولید نباید عمومی باشد | `4000` |
| `WEB_HOST_PORT` | بله | خیر | پورت محلی وب (پشت nginx میزبان) | `8080` |
| `WEB_BIND_ADDR` | بله | خیر | آدرس bind پورت وب؛ پیش‌فرض `127.0.0.1`؛ فقط وقتی nginx روی میزبانِ دیگر است و رابط خصوصی دارد `0.0.0.0` شود | `127.0.0.1` |
| `MINIO_CONSOLE_BIND` | بله | خیر | آدرس bind کنسول MinIO (هرگز عمومی نشود) | `127.0.0.1` |
| `GRAFANA_ADMIN_PASSWORD` | فقط پروفایل `observability` | **بله** | رمز ادمین Grafana | `openssl rand -base64 24` |
| `DOMAIN` | بله | خیر | دامنهٔ عمومی برای Caddy | `erp.carexy.shop` |
| `ACME_EMAIL` | بله در پروفایل TLS | خیر | ایمیل Let's Encrypt برای هشدار انقضا | `admin@carexy.shop` |
| `IMAGE_TAG` | بله | خیر | تگ ایمیج؛ برای rollback تغییر می‌دهید | `1.0.0` |

> **نکتهٔ رمزها در حالت کانتینر:** برای اینکه یک رمز برای هر پنج نقش تکرار نشود، بعد از اولین راه‌اندازی رمز نقش‌ها را جدا کنید (بخش ۸.۲، «چرخش رمز نقش‌ها»). تا آن زمان `DATABASE_URL`/`MIGRATION_DATABASE_URL` از همان `POSTGRES_PASSWORD` استفاده می‌کنند؛ نقش‌ها از نظر دسترسی همچنان جدا و کم‌دسترسی هستند.

### ۶.۴ اعتبارسنجی سریع `.env`

```bash
cd /opt/saman-erp
grep -n 'CHANGE_ME' .env       # باید هیچ خروجی نداشته باشد
grep -c '^[A-Z]' .env           # تعداد متغیرهای تعریف‌شده (برای مقایسه با .env.example)
awk -F= '/^[A-Z]/{print $1}' .env.example | sort > /tmp/example.keys
awk -F= '/^[A-Z]/{print $1}' .env | sort > /tmp/env.keys
diff /tmp/example.keys /tmp/env.keys   # هیچ متغیری نباید جا افتاده باشد
```

**چرا:** خطای رایج تولید، جا افتادن یک متغیر است؛ Zod در boot خطا می‌دهد اما یافتن نام متغیر در لاگ کند است.

### ۶.۵ بارگذاری متغیرها در shell

دستورهایی که در ادامهٔ سند از `$POSTGRES_USER`، `$POSTGRES_DB`، `$REDIS_PASSWORD`، `$MINIO_ROOT_USER` و مانند آن استفاده می‌کنند، فرض می‌کنند متغیرهای `.env` در shell جاری بارگذاری شده‌اند. یک‌بار در هر نشست SSH اجرا کنید:

```bash
cd /opt/saman-erp
set -a
. ./.env
set +a
grep -c '^[A-Z]' .env        # فقط برای اطمینان از بارگذاری
```

> `docker compose` خودش `.env` را می‌خواند؛ این کار فقط برای دستورهای دستی `psql`/`mc`/`curl` داخل کانتینر لازم است. اگر دستور `source` می‌دهید، مراقب نبودن فاصله یا نقل‌قول در مقادیر `.env` باشید.

---

## ۷. راه‌اندازی اولیه و بررسی سلامت زیرساخت

قبل از بالا آوردن همه چیز، فقط زیرساخت را بالا بیاورید تا خطاها جدا و قابل فهم باشند.

```bash
cd /opt/saman-erp
docker compose config -q          # اعتبارسنجی نحوی Compose و .env
docker compose pull postgres redis minio
docker compose up -d postgres redis minio minio-init
sleep 20
docker compose ps
```

انتظار: `postgres`، `redis`، `minio` وضعیت `healthy`؛ `minio-init` با کد خروج ۰ تمام شده باشد (`Exited (0)`).

```bash
docker compose logs --tail=50 postgres
docker compose logs --tail=30 redis
docker compose logs --tail=30 minio
docker compose logs --tail=30 minio-init
```

**بررسی‌های سریع:**

```bash
# PostgreSQL
docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"

# Redis (با رمز)
docker compose exec -T redis redis-cli -a "$REDIS_PASSWORD" ping

# MinIO — پورت ۹۰۰۰ روی میزبان publish نیست، پس از داخل شبکهٔ Docker تست کنید
docker compose ps minio          # انتظار: healthy
docker compose run --rm --entrypoint sh minio-init -c '
  mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc ready local && echo "MinIO OK"'
```

> اگر `minio-init` شکست خورد، `docker compose logs minio-init` را بخوانید؛ علت رایج، تطابق نداشتن `S3_ACCESS_KEY`/`S3_SECRET_KEY` با سیاست باکت است.

---

## ۸. گزینهٔ الف — PostgreSQL داخل Compose (پیشنهادی)

این گزینه برای اکثر مشتری‌ها پیشنهادی است: بدون نصب جداگانه، بکاپ‌گیری یکپارچه، و همه چیز با یک `docker compose up` مدیریت می‌شود.

### ۸.۱ مشخصات سرویس

| مورد | مقدار |
|---|---|
| ایمیج | `postgres:16-alpine` |
| پورت | `5432` فقط در شبکهٔ `backend` (هیچ publish عمومی نداریم) |
| Volume | `pgdata` → `/var/lib/postgresql/data` |
| Healthcheck | `pg_isready -U saman -d saman` هر ۱۰ ثانیه |
| Restart | `unless-stopped` |

### ۸.۲ نقش‌ها، schema و extension (قرارداد init)

در اولین راه‌اندازی با Volume خالی، اسکریپت `infra/docker/postgres/init/01-init.sh` با کاربر مدیر (`POSTGRES_USER`) این کارها را انجام می‌دهد:

1. ساخت extensionهای `pgcrypto`، `pg_trgm`، `btree_gin`.
2. ساخت پنج نقش: `saman_migrator` (DDL و مالک schema `erp`)، `saman_app` (DML بدون DDL)، `saman_worker` (DML با `statement_timeout` بلندتر برای پردازش‌های دسته‌ای)، `saman_readonly` (فقط خواندن برای گزارش‌ها)، `saman_backup` (فقط خواندن برای `pg_dump`).
3. ساخت schema `erp` با مالکیت `saman_migrator`.
4. `ALTER DEFAULT PRIVILEGES` تا جدول‌های آیندهٔ مهاجرت‌ها خودکار دسترسی بگیرند.
5. رمز اولیهٔ هر پنج نقش را از `POSTGRES_PASSWORD` می‌گذارد (بعداً جدا کنید — پایین همین بخش) و `statement_timeout=30s` را به‌عنوان تور امنیتی روی `saman_app` تنظیم می‌کند؛ API در کد `DB_STATEMENT_TIMEOUT_MS=5000` را اعمال می‌کند.

**چرا نقش جدا برای مهاجرت؟** `ARCHITECTURE.md §10` می‌گوید برنامه باید «کمترین دسترسی» داشته باشد. اگر API با نقش DDL اجرا شود، یک SQL Injection می‌تواند schema را نابود کند. `saman_app` نمی‌تواند `DROP`/`ALTER` کند.

**معادل SQL قراردادی init (برای بازبینی و برای اجرای دستی در صورت نیاز):**

```bash
# داخل کانتینر دیتابیس، با کاربر مدیر. رمز اولیهٔ هر پنج نقش را برابر POSTGRES_PASSWORD بگذارید.
set -a; . ./.env; set +a
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -v app_pw="$POSTGRES_PASSWORD" \
  -v worker_pw="$POSTGRES_PASSWORD" \
  -v migrator_pw="$POSTGRES_PASSWORD" \
  -v ro_pw="$POSTGRES_PASSWORD" \
  -v backup_pw="$POSTGRES_PASSWORD" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

CREATE ROLE saman_migrator LOGIN PASSWORD :'migrator_pw';
CREATE ROLE saman_app      LOGIN PASSWORD :'app_pw';
CREATE ROLE saman_worker   LOGIN PASSWORD :'worker_pw';
CREATE ROLE saman_readonly LOGIN PASSWORD :'ro_pw';
CREATE ROLE saman_backup   LOGIN PASSWORD :'backup_pw';
GRANT pg_read_all_data TO saman_backup;

GRANT CONNECT, CREATE ON DATABASE saman TO saman_migrator;
CREATE SCHEMA IF NOT EXISTS erp AUTHORIZATION saman_migrator;
GRANT USAGE ON SCHEMA erp TO saman_app, saman_worker, saman_readonly, saman_backup;

ALTER DEFAULT PRIVILEGES FOR ROLE saman_migrator IN SCHEMA erp
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO saman_app;
ALTER DEFAULT PRIVILEGES FOR ROLE saman_migrator IN SCHEMA erp
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO saman_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE saman_migrator IN SCHEMA erp
  GRANT SELECT ON TABLES TO saman_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE saman_migrator IN SCHEMA erp
  GRANT USAGE, SELECT ON SEQUENCES TO saman_app;

ALTER ROLE saman_app SET statement_timeout = '30s';
ALTER ROLE saman_worker SET statement_timeout = '30m';
ALTER ROLE saman_app SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE saman_migrator SET statement_timeout = 0;
SQL
```

> در حالت کانتینر، init به‌جای `:$variable` از `ALTER ROLE ... PASSWORD '$POSTGRES_PASSWORD'` استفاده می‌کند. اگر اجرای دوبارهٔ دستی می‌کنید و نقش‌ها از قبل هستند، خطوط `CREATE ROLE` را با `ALTER ROLE ... PASSWORD` جایگزین کنید.

**چرخش رمز نقش‌ها (توصیه‌شده بعد از نصب):**

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "ALTER ROLE saman_app PASSWORD '$(openssl rand -hex 32)';"
# رمز جدید را در DATABASE_URL جایگزین کنید
docker compose up -d api worker
```

### ۸.۳ بررسی نقش‌ها

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\du"
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\dn"
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SHOW ssl;"
```

انتظار: نقش مدیر با نام مقدار `POSTGRES_USER` (نمونه: `saman`) به‌عنوان سوپریوزر، و پنج نقش `saman_migrator`، `saman_app`، `saman_worker`، `saman_readonly`، `saman_backup`؛ همچنین schema `erp`.

### ۸.۴ Tuning پیشنهادی PostgreSQL

برای سرور ۸ GB / ۴ vCPU، این پرچم‌ها در `command` سرویس `postgres` (فایل Compose، مالکیت تیم پلتفرم) قرار می‌گیرند:

```yaml
command:
  - postgres
  - -c
  - shared_buffers=1GB
  - -c
  - effective_cache_size=3GB
  - -c
  - work_mem=16MB
  - -c
  - maintenance_work_mem=256MB
  - -c
  - max_connections=150
  - -c
  - wal_compression=on
  - -c
  - checkpoint_completion_target=0.9
  - -c
  - random_page_cost=1.1
```

برای سرور ۱۶ GB: `shared_buffers=4GB`، `effective_cache_size=10GB`، `maintenance_work_mem=1GB`، `max_connections=250`.

**قاعدهٔ اتصال:** `max_connections` باید از مجموع `DB_POOL_MAX` همهٔ پردازه‌ها + حاشیهٔ ادمین بزرگ‌تر باشد. مثال: `api`×۲ (۴۰) + `worker` (۲۰) + مهاجرت/ادمین (۱۰) + حاشیه = ۱۰۰ در برابر `max_connections=150`.

### ۸.۵ دسترسی ادمین به دیتابیس کانتینری

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

اگر لازم شد موقتاً از میزبان وصل شوید، فقط از طریق tunnel:

```bash
ssh -L 5432:127.0.0.1:5432 saman@erp.carexy.shop
# در ترمینال دوم؛ پورت دیتابیس در Compose نباید عمومی publish شده باشد
psql "postgres://saman_app:<db-hex>@127.0.0.1:5432/saman"
```

---

## ۹. گزینهٔ ب — PostgreSQL خارجی یا مدیریت‌شده

اگر مشتری PostgreSQL جدا دارد (سرور مستقل، RDS، Cloud SQL، Arvan یا خوشهٔ موجود)، از این بخش استفاده کنید.

### ۹.۱ نصب PostgreSQL 16 بومی روی Ubuntu (اگر ندارید)

```bash
sudo apt-get install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
sudo apt-get update
sudo apt-get install -y postgresql-16 postgresql-contrib-16
sudo systemctl enable --now postgresql
sudo -u postgres psql -c "SELECT version();"
```

> اگر اسکریپت `pgdg` موجود نبود: `curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /usr/share/keyrings/pgdg.gpg` و سپس خط `deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt <codename>-pgdg main` را در `/etc/apt/sources.list.d/pgdg.list` بگذارید.

### ۹.۲ دسترسی شبکه و احراز هویت

`postgresql.conf`:

```conf
listen_addresses = '*'
password_encryption = scram-sha-256
ssl = on
ssl_cert_file = '/etc/postgresql/16/main/server.crt'
ssl_key_file  = '/etc/postgresql/16/main/server.key'
ssl_min_protocol_version = 'TLSv1.2'
```

`pg_hba.conf` — فقط شبکهٔ برنامه اجازه بگیرد:

```conf
# ادمین محلی
local   all             postgres                           peer
# برنامه روی شبکهٔ خصوصی، فقط TLS
hostssl saman           saman_app       10.20.0.0/24       scram-sha-256
hostssl saman           saman_migrator  10.20.0.0/24       scram-sha-256
hostssl saman           saman_backup    10.20.0.0/24       scram-sha-256
# مدیریت از bastion
hostssl all             postgres        10.20.0.9/32       scram-sha-256
```

TLS داخلی (خودامضا):

```bash
sudo -u postgres openssl req -new -x509 -days 3650 -nodes \
  -out /etc/postgresql/16/main/server.crt \
  -keyout /etc/postgresql/16/main/server.key \
  -subj "/CN=db.erp.internal"
sudo chown postgres:postgres /etc/postgresql/16/main/server.{crt,key}
sudo chmod 600 /etc/postgresql/16/main/server.key
sudo systemctl restart postgresql
```

سپس `server.crt` را به‌عنوان CA در سرور برنامه در `/opt/saman-erp/certs/db-ca.pem` کپی کنید و پوشهٔ `certs/` را در `.gitignore` نگه دارید (مخزن از قبل `*.pem` را نادیده می‌گیرد).

> در سرویس مدیریت‌شده، CA و کاربر ادمین را ارائه‌دهنده می‌دهد؛ `listen_addresses`/`pg_hba` دست شما نیست. Security Group/Firewall را به IP سرور برنامه محدود کنید و `DB_SSL=true` با `DB_SSL_CA_PATH` را الزامی کنید.

### ۹.۳ ساخت دیتابیس، نقش‌ها و schema

با نقش ادمین (`postgres`) اجرا کنید. **بار اول** (برای اجرای تکراری، خطوط `CREATE DATABASE`/`CREATE ROLE` را با `ALTER` جایگزین کنید):

```bash
sudo -u postgres psql -d postgres \
  -v migrator_pw="<hex-32>" -v app_pw="<hex-32>" -v worker_pw="<hex-32>" -v ro_pw="<hex-32>" -v backup_pw="<hex-32>" <<'SQL'
CREATE DATABASE saman OWNER postgres;
CREATE ROLE saman_migrator LOGIN PASSWORD :'migrator_pw';
CREATE ROLE saman_app      LOGIN PASSWORD :'app_pw';
CREATE ROLE saman_worker   LOGIN PASSWORD :'worker_pw';
CREATE ROLE saman_readonly LOGIN PASSWORD :'ro_pw';
CREATE ROLE saman_backup   LOGIN PASSWORD :'backup_pw';
GRANT pg_read_all_data TO saman_backup;
\connect saman
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;
GRANT CONNECT, CREATE ON DATABASE saman TO saman_migrator;
CREATE SCHEMA IF NOT EXISTS erp AUTHORIZATION saman_migrator;
GRANT USAGE ON SCHEMA erp TO saman_app, saman_worker, saman_readonly, saman_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE saman_migrator IN SCHEMA erp
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO saman_app;
ALTER DEFAULT PRIVILEGES FOR ROLE saman_migrator IN SCHEMA erp
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO saman_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE saman_migrator IN SCHEMA erp
  GRANT SELECT ON TABLES TO saman_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE saman_migrator IN SCHEMA erp
  GRANT USAGE, SELECT ON SEQUENCES TO saman_app;
ALTER ROLE saman_app SET statement_timeout = '30s';
ALTER ROLE saman_worker SET statement_timeout = '30m';
ALTER ROLE saman_app SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE saman_migrator SET statement_timeout = 0;
SQL
```

**چرا `ALTER DEFAULT PRIVILEGES`؟** جدول‌ها در آینده توسط `saman_migrator` ساخته می‌شوند. بدون این تنظیم، نقش برنامه بعد از هر مهاجرت به جدول جدید دسترسی ندارد و باید دستی `GRANT` بدهید (منبع فراموشی و حادثه).

### ۹.۴ ست کردن `DATABASE_URL` و `MIGRATION_DATABASE_URL`

در `.env` (مقادیر hex نیاز به URL-encode ندارند):

```dotenv
DATABASE_URL=postgres://saman_app:<app-hex>@db.erp.internal:5432/saman
MIGRATION_DATABASE_URL=postgres://saman_migrator:<migrator-hex>@db.erp.internal:5432/saman
DB_SSL=true
DB_SSL_CA_PATH=/run/secrets/db-ca.pem
```

اپراتور باید در Compose سرویس‌های `api`، `worker` و `migrate` فایل CA را mount کند:

```yaml
    volumes:
      - ./certs/db-ca.pem:/run/secrets/db-ca.pem:ro
```

**تست اتصال از داخل شبکهٔ Docker** (قبل از مهاجرت):

```bash
docker compose run --rm --entrypoint sh api -c '
  node -e "const postgres=require(\"postgres\"); const s=postgres(process.env.DATABASE_URL,{max:1,connect_timeout:10}); s\`select current_user, current_database(), version()\`.then(r=>{console.log(r);process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"
'
```

> `DB_SSL=true` به‌تنهایی گواهی را verify نمی‌کند؛ برای امنیت کامل `DB_SSL_CA_PATH` را هم بدهید. `require` بدون verify فقط رمزنگاری است و MITM را نمی‌بندد.

### ۹.۵ چه چیزهایی باید در DB خارجی رعایت شود؟

- PostgreSQL نسخهٔ **۱۶** (حداقل ۱۵).
- extensionهای `pgcrypto`، `pg_trgm`، `btree_gin` (در RDS/Cloud SQL معمولاً از پنل؛ در Arvan/سرور خودی با اسکریپت ۹.۳).
- نقش‌های چهارگانه و `ALTER DEFAULT PRIVILEGES` طبق ۹.۳.
- پارتیشن‌بندی ماهانه در همان دیتابیس (worker با نقش migrator پارتیشن می‌سازد).
- بکاپ: `pg_dump` از سرور برنامه با نقش `saman_backup` یا از خود سرویس مدیریت‌شده؛ اگر snapshot دارد هم شبانه dump را برای بازیابی انتخابی نگه دارید.
- همگام‌سازی ساعت سرور DB (`chrony`).

---

## ۱۰. مهاجرت دیتابیس، Seed و ساخت اولین مدیر

طبق `ADR-0012` مهاجرت **مرحلهٔ انتشار صریح** است، نه خودکار روی boot. برای همین از سرویس یک‌بارهٔ پروفایل `tools` استفاده می‌کنیم.

### ۱۰.۱ اجرای مهاجرت‌ها

```bash
cd /opt/saman-erp
docker compose --profile tools run --rm migrate
```

این سرویس با ایمیج `api`، نقش `saman_migrator` (`MIGRATION_DATABASE_URL`) و فرمان `pnpm db:migrate` اجرا می‌شود.

بررسی نتیجه:

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT count(*) AS tables FROM information_schema.tables WHERE table_schema='erp';"
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT count(*) AS partitions FROM pg_inherits;"
```

انتظار: جدول‌های schema `erp` (بسته به فاز پیاده‌سازی) و پارتیشن‌های ماهانه ایجادشده. در DB خارجی همین را با `psql "$MIGRATION_DATABASE_URL"` اجرا کنید.

### ۱۰.۲ Seed (نقش‌ها، مجوزها، کدینگ حسابداری، واحدها، کانال‌ها)

قبل از اجرا، فقط در **اولین نصب**، سه خط Bootstrap را در `.env` ست کنید:

```bash
cd /opt/saman-erp
# مقادیر واقعی را جایگزین کنید؛ رمز با openssl rand -base64 24 ساخته شود
sed -i 's|^BOOTSTRAP_ADMIN_MOBILE=.*|BOOTSTRAP_ADMIN_MOBILE=09121234567|' .env
sed -i "s|^BOOTSTRAP_ADMIN_PASSWORD=.*|BOOTSTRAP_ADMIN_PASSWORD=$(openssl rand -base64 24)|" .env
sed -i 's|^BOOTSTRAP_ORG_NAME=.*|BOOTSTRAP_ORG_NAME=کرکسی شاپ|' .env
grep -E '^BOOTSTRAP_' .env
```

سپس:

```bash
docker compose --profile tools run --rm migrate pnpm db:seed
```

Seed **idempotent** است و در هر استقرار قابل اجراست (`ADR-0008`): مجوزهای کد، نقش‌های سیستمی، ساختار ۶ سطحی کدینگ حسابداری ایران، واحدهای اندازه‌گیری، کانال‌های پیش‌فرض، تنظیمات پایه — و **مدیر اول فقط اگر جدول `users` خالی باشد** با مقادیر `BOOTSTRAP_ADMIN_*` ساخته می‌شود.

**بررسی ساخته شدن مدیر:**

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT id, mobile, is_active, created_at FROM erp.users ORDER BY id LIMIT 5;"
```

### ۱۰.۳ حذف مقادیر Bootstrap

```bash
cd /opt/saman-erp
sed -i 's|^BOOTSTRAP_ADMIN_PASSWORD=.*|#BOOTSTRAP_ADMIN_PASSWORD=|' .env
sed -i 's|^BOOTSTRAP_ADMIN_MOBILE=.*|#BOOTSTRAP_ADMIN_MOBILE=|' .env
grep -E '^BOOTSTRAP_' .env        # باید فقط خطوط کامنت‌شده باشند
```

رمز مدیر اول را در **اولین ورود** از پروفایل تغییر دهید. **چرا:** مقدار Bootstrap در تاریخچهٔ shell/فایل باقی می‌ماند و برای محیط تولید مناسب نیست.

> **روش اختیاری CLI:** اگر اسکریپت `db:create-admin` در نسخهٔ شما موجود است، می‌توانید به‌جای Bootstrap از آن استفاده کنید:
> `docker compose --profile tools run --rm api pnpm --filter @saman/api db:create-admin`
> این روش تعاملی است و رمز در تاریخچهٔ shell نمی‌ماند، اما مسیر پشتیبانی‌شدهٔ رسمی همان `seed` با `BOOTSTRAP_*` است.

---

## ۱۱. راه‌اندازی سرویس‌ها و رسیدن به صفحهٔ ورود فارسی

### ۱۱.۱ بیلد و راه‌اندازی (بدون TLS، برای تست داخلی)

```bash
cd /opt/saman-erp
docker compose build
docker compose up -d
docker compose ps
```

انتظار: همهٔ سرویس‌ها `Up`/`healthy`؛ `api` روی پورت داخلی `4000` سالم؛ `web` روی `127.0.0.1:${WEB_HOST_PORT}` (پیش‌فرض `8080`).

### ۱۱.۲ بررسی سلامتی

```bash
# از داخل شبکهٔ Docker (کانتینر api) — پورت ۴۰۰۰
docker compose exec -T api wget -qO- http://127.0.0.1:4000/health/live
docker compose exec -T api wget -qO- http://127.0.0.1:4000/health/ready
docker compose exec -T api wget -qO- http://127.0.0.1:4000/health/version

# از میزبان از طریق web (nginx داخلی → api:4000)
curl -fsS http://127.0.0.1:8080/health/live
curl -fsS http://127.0.0.1:8080/health/ready
curl -fsS http://127.0.0.1:8080/healthz
```

معنی endpointها (`ARCHITECTURE.md §12`):

| مسیر | معنی |
|---|---|
| `/health/live` | پردازه زنده است؛ چیزی را چک نمی‌کند |
| `/health/ready` | دیتابیس + Redis + S3 قابل استفاده‌اند؛ اگر `503` داد سرویس نباید ترافیک بگیرد |
| `/health/version` | نسخهٔ اپ و نسخهٔ schema |
| `/metrics` | متریک Prometheus؛ **عمومی نکنید** (پشت شبکهٔ داخلی یا با احراز هویت) |

### ۱۱.۳ تست صفحهٔ ورود فارسی

```bash
curl -sI http://127.0.0.1:8080/ | head -20
# انتظار: 200 OK و Content-Type: text/html
curl -s http://127.0.0.1:8080/ | grep -o 'lang="fa"' | head -1   # انتظار: lang="fa"
```

از مرورگر (از طریق SSH tunnel اگر پورت عمومی بسته است):

```bash
ssh -L 8080:127.0.0.1:8080 saman@erp.carexy.shop
# مرورگر: http://127.0.0.1:8080
```

**معیار پذیرش نصب:** صفحهٔ ورود باید **کاملاً فارسی و راست‌به‌چپ (RTL)** با فونت Vazirmatn باشد، برچسب‌ها فارسی باشند (`موبایل`، `رمز عبور`، `ورود`) و هیچ متن انگلیسی پنهانی/راهنمای توسعه‌دهنده دیده نشود. ورود با موبایل/رمز مدیر → داشبورد → فهرست کالاها. اگر صفحه انگلیسی یا LTR بود، `APP_DEFAULT_LOCALE=fa-IR` را بررسی و ایمیج `web` را با تگ درست دوباره بیلد کنید.

### ۱۱.۴ ساخت دادهٔ پایه از داخل UI

پس از ورود:
1. **سازمان و شعبه** (`settings/org`) — نام شرکت، لوگو، سال مالی.
2. **سال مالی و دوره‌ها** — سال مالی جاری (مثلاً ۱۴۰۵)؛ دوره‌ها خودکار ساخته می‌شوند.
3. **انبار و مکان‌ها** — حداقل یک انبار و یک location پیش‌فرض.
4. **کانال‌ها** — اعتبارنامهٔ Carexy (`CAREXY_API_KEY`، base `https://carexy.shop`) و در صورت فعال بودن، دیجی‌کالا؛ سپس «تست اتصال».
5. **کاربران** — ساخت حساب‌های تیم با نقش‌های حداقلی و مناسب.

---

## ۱۲. TLS — گزینهٔ الف: Caddy داخلی / گزینهٔ ب: nginx موجود

### گزینهٔ الف — Caddy با Let's Encrypt (توصیه‌شده)

**پیش‌نیاز:** رکورد `A` دامنه `erp.carexy.shop` به IP سرور اشاره کند و پورت‌های ۸۰/۴۴۳ باز باشند.

```bash
cd /opt/saman-erp
# در .env: DOMAIN=erp.carexy.shop و ACME_EMAIL=admin@carexy.shop
docker compose --profile tls up -d caddy
docker compose logs -f caddy
```

Caddy خودکار گواهی می‌گیرد و تمدید می‌کند؛ گواهی‌ها در volume `caddy_data` می‌مانند. `infra/nginx/Caddyfile` قراردادی:

```caddyfile
{$DOMAIN} {
    encode zstd gzip
    reverse_proxy web:8080
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
        -Server
    }
    log {
        output stdout
        format json
    }
}
```

بررسی:

```bash
curl -sI https://erp.carexy.shop | head -20
curl -fsS https://erp.carexy.shop/health/ready
docker compose exec -T caddy caddy list-certificates
```

**عیب‌یابی رایج ACME:** اگر DNS هنوز propagate نشده، Caddy خطای challenge می‌دهد. برای تست بدون مصرف سهمیهٔ Let's Encrypt می‌توانید موقتاً `acme_ca https://acme-staging-v02.api.letsencrypt.org/directory` را در Caddyfile اضافه کنید (فقط آزمایش؛ بعداً حذف کنید).

### گزینهٔ ب — nginx موجود مشتری

اگر مشتری reverse proxy/TLS خودش را دارد (یا باید کنار سایت دیگری روی ۴۴۳ بنشیند)، پورت ۸۰/۴۴۳ را به nginx میزبان بدهید و `web` را روی loopback نگه دارید.

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

`/etc/nginx/sites-available/saman.conf` (از `infra/nginx/saman.conf` استفاده کنید):

```nginx
upstream saman_web {
    server 127.0.0.1:8080;
    keepalive 16;
}

server {
    listen 80;
    listen [::]:80;
    server_name erp.carexy.shop;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name erp.carexy.shop;

    ssl_certificate     /etc/letsencrypt/live/erp.carexy.shop/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/erp.carexy.shop/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    client_max_body_size 25m;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    location / {
        proxy_pass http://saman_web;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_read_timeout 60s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/saman.conf /etc/nginx/sites-enabled/saman.conf
sudo nginx -t
sudo certbot --nginx -d erp.carexy.shop --redirect -m "admin@carexy.shop"
sudo systemctl reload nginx
sudo certbot renew --dry-run
```

**چرا `X-Forwarded-For` و `TRUST_PROXY=true`؟** بدون آن، محدودیت نرخ و لاگ audit همه را با IP پروکسی می‌بینند و rate limit درست کار نمی‌کند. همچنین با `COOKIE_SECURE=true` کوکی فقط روی HTTPS ارسال می‌شود.

**در این حالت پروفایل `tls`/Caddy را اجرا نکنید** تا پورت ۸۰/۴۴۳ تداخل نداشته باشد.

> **آدرس bind وب:** WEB_BIND_ADDR پیش‌فرض 127.0.0.1 است و برای nginx روی همان میزبان کافی است. فقط اگر nginx روی **میزبان دیگری** است و از رابط خصوصی به این سرور وصل می‌شود، آن را  .0.0.0 کنید؛ در این حالت پورت WEB_HOST_PORT را با فایروال/DOCKER-USER به IP خصوصی nginx محدود کنید و هرگز آن را عمومی نکنید.

### ۱۲.۳ اعتبارسنجی نهایی TLS

```bash
curl -sI https://erp.carexy.shop | grep -E 'HTTP/|strict-transport'
curl -fsS https://erp.carexy.shop/health/ready
openssl s_client -connect erp.carexy.shop:443 -servername erp.carexy.shop </dev/null 2>/dev/null | openssl x509 -noout -dates -subject
```

> HSTS فقط بعد از اطمینان از کارکرد پایدار HTTPS فعال شود؛ در غیر این صورت کاربران تا یک سال به HTTPS معیوب قفل می‌شوند.

---

## ۱۳. فایروال، سخت‌سازی SSH و امنیت میزبان

### ۱۳.۱ UFW

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from <IP-مدیر> to any port 22 proto tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

**هشدار مهم Docker:** Docker قواعد iptables خودش را جلوتر از UFW می‌گذارد؛ پورتی که در Compose `ports:` شود حتی اگر UFW آن را نبندد از بیرون قابل دسترسی است. برای همین:
- `postgres`، `redis`، `minio` **هیچ** port publish عمومی ندارند (فقط شبکهٔ داخلی).
- `web` فقط روی `127.0.0.1:${WEB_HOST_PORT}` bind شود.
- کنسول MinIO فقط `127.0.0.1:9001`.
- `API_HOST_PORT` در تولید باز نشود.

لایهٔ دفاعی اضافه با `DOCKER-USER`:

```bash
sudo iptables -I DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
sudo iptables -A DOCKER-USER -i <nic-public> -p tcp --dport 5432 -j DROP
sudo apt-get install -y iptables-persistent
sudo netfilter-persistent save
```

### ۱۳.۲ سخت‌سازی SSH

ابتدا مطمئن شوید کلید SSH شما کار می‌کند (در ترمینال جداگانه تست کنید!)، سپس:

```bash
sudo tee /etc/ssh/sshd_config.d/99-saman.conf > /dev/null <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowUsers saman
MaxAuthTries 3
ClientAliveInterval 300
ClientAliveCountMax 2
EOF
sudo sshd -t
sudo systemctl reload ssh
sudo systemctl enable --now fail2ban
sudo fail2ban-client status sshd
```

### ۱۳.۳ سخت‌سازی کانتینرها (قرارداد Compose)

فایل Compose باید برای `api`/`worker`/`web` این موارد را داشته باشد:

```yaml
    read_only: true
    tmpfs:
      - /tmp:size=256m,mode=1777
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    init: true
    user: "1000:1000"      # کاربر غیر root داخل ایمیج
```

**چرا:** اگر مهاجم داخل کانتینر API کد اجرا کند، root فایل‌سیستم read-only و بدون capability نمی‌تواند سیستم میزبان را دستکاری کند. نوشتن فقط در `/tmp` و volumeهای صریح مجاز است.

---

## ۱۴. بکاپ‌گیری خودکار و آموزش بازیابی

جزئیات کامل و سناریوهای بازیابی در `docs/07-operations/BACKUP-RESTORE.md`؛ اینجا فقط راه‌اندازی عملی.

### ۱۴.۱ راه‌اندازی سرویس backup

```bash
cd /opt/saman-erp
docker compose --profile backup up -d backup
docker compose logs -f backup
```

سرویس `backup` طبق `BACKUP_CRON` (پیش‌فرض `0 2 * * *` = هر شب ۲ بامداد) اجرا می‌شود، `pg_dump -Fc` می‌گیرد، `sha256` می‌سازد، با GPG (AES-256، رمز `BACKUP_ENCRYPTION_PASSPHRASE`) رمزگذاری و با پیشوند `BACKUP_S3_PREFIX` در باکت `saman-backups` آپلود می‌کند. بکاپ‌های قدیمی‌تر از `BACKUP_KEEP_DAYS` پاک می‌شوند.

> **آینهٔ Offsite (اختیاری):** اگر BACKUP_MIRROR_S3_ENDPOINT/BACKUP_MIRROR_S3_BUCKET/BACKUP_MIRROR_S3_ACCESS_KEY/BACKUP_MIRROR_S3_SECRET_KEY در .env تنظیم شوند، سرویس backup همان فایل رمزگذاری‌شده و sha256 را به account/provider دوم هم کپی می‌کند (الزام تولید). این چهار کلید هنوز در .env.example نیستند و باید توسط تیم پلتفرم اضافه شوند؛ تا آن زمان روی سرور تنظیم شوند.

### ۱۴.۲ RPO و PITR (مهم و صادقانه)

- با تنظیم پیش‌فرض (`pg_dump` شبانه)، **RPO عملاً تا ۲۴ ساعت** است؛ یعنی اگر سرور ظهر از بین برود، داده از بامداد تا ظهر قابل بازیابی نیست.
- هدف `ARCHITECTURE.md §14` یعنی **RPO ≤ ۱۵ دقیقه** فقط با پروفایل اختیاری **PITR (pgBackRest + آرشیو WAL)** محقق می‌شود. این پروفایل در v1 اختیاری است و نیازمند ایمیج سفارشی PostgreSQL با `pgbackrest` و فایل `infra/backup/pgbackrest.conf` است؛ با تیم پلتفرم هماهنگ کنید.
- برای ۱۰k کالا و TPS بالا، فعال‌سازی PITR **توصیهٔ اکید** است. تا آن زمان این محدودیت را کتباً به مشتری اعلام کنید.

### ۱۴.۳ تست دستی بکاپ (همین امروز انجام دهید)

```bash
docker compose --profile backup run --rm backup once
# فهرست بکاپ‌ها از داخل کانتینر mc (minio-init) — پورت MinIO روی میزبان باز نیست
set -a; . ./.env; set +a
docker compose run --rm --entrypoint sh minio-init -c '
  mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc ls --recursive local/saman-backups/backups/postgres'
```

انتظار: یک فایل `saman-erp-YYYYMMDDTHHMMSSZ.dump.gpg` و فایل `.sha256` کنارش.

### ۱۴.۴ بکاپ پیکربندی و رمزها (خارج از Compose)

```bash
cd /opt/saman-erp
tar -czf /tmp/saman-config-$(date +%F).tar.gz \
  .env docker-compose.yml infra/ certs/ 2>/dev/null
gpg --batch --yes --symmetric --cipher-algo AES256 \
  --passphrase "$BACKUP_ENCRYPTION_PASSPHRASE" \
  -o /root/saman-config-$(date +%F).tar.gz.gpg /tmp/saman-config-$(date +%F).tar.gz
shred -u /tmp/saman-config-$(date +%F).tar.gz
```

فایل `.gpg` را Offsite کنید و **رمز GPG بکاپ را جدا و آفلاین** نگه دارید (گاوصندوق یا مدیر امنیت). بدون آن، بکاپ قابل بازیابی نیست.

### ۱۴.۵ تمرین بازیابی (Release Gate)

طبق `README §7` و `ARCHITECTURE §14`، قبل از تحویل به مشتری و هر فصل یک بار:

1. آخرین dump را از MinIO به ماشین تست دانلود و decrypt کنید.
2. در یک کانتینر PostgreSQL **تازه** restore کنید (مسیر دقیق: `BACKUP-RESTORE.md §6`).
3. `psql` بزنید: تعداد جدول‌ها، آخرین رکورد `inventory_transactions` و `SELECT count(*) FROM erp.users;`
4. `migrate` را روی دیتابیس تازه اجرا کنید (باید بدون خطا و در حد head باشد) و سپس `api` را با `DATABASE_URL` همان کانتینر تازه بالا بیاورید.
5. `login → dashboard → product list` را تست کنید و زمان بازیابی را ثبت کنید (هدف RTO ≤ ۱ ساعت).

---

## ۱۵. ارتقا و برگشت (Upgrade / Rollback)

### ۱۵.۱ آماده‌سازی

```bash
cd /opt/saman-erp
docker compose --profile backup run --rm backup once    # ۱) بکاپ قبل از هر ارتقا
docker compose ps                                       # ۲) وضعیت سالم
git fetch --tags && git log --oneline -5                 # ۳) مشاهدهٔ تگ مقصد
```

### ۱۵.۲ ارتقا

```bash
# ۱) تغییر تگ در .env: IMAGE_TAG=1.1.0
git checkout v1.1.0
docker compose pull
docker compose build

# ۲) مهاجرت دیتابیس (قبل از کد جدید — سازگاری رو به جلو)
docker compose --profile tools run --rm migrate

# ۳) seed idempotent (مجوزها/نقش‌های جدید)
docker compose --profile tools run --rm migrate pnpm db:seed

# ۴) بازسازی سرویس‌های بی‌حالت
docker compose up -d --no-deps api worker web

# ۵) بررسی
sleep 15
docker compose ps
docker compose exec -T api wget -qO- http://127.0.0.1:4000/health/ready
curl -fsS https://erp.carexy.shop/health/ready
```

**قانون سازگاری مهاجرت:** هر مهاجرت باید `expand → migrate → contract` باشد؛ یعنی نسخهٔ قبلی کد با schema جدید هم کار کند. در غیر این صورت rollback بدون restore ممکن نیست.

### ۱۵.۳ برگشت

**اگر مهاجرت سازگار بود:**

```bash
git checkout v1.0.0
# IMAGE_TAG=1.0.0 در .env
docker compose pull && docker compose up -d --no-deps api worker web
docker compose exec -T api wget -qO- http://127.0.0.1:4000/health/ready
```

**اگر مهاجرت ناسازگار بود (Rollback + Restore):**

1. سرویس‌ها را متوقف کنید: `docker compose stop api worker web`
2. طبق `BACKUP-RESTORE.md §6.3` آخرین dump **قبل از ارتقا** را restore کنید.
3. `IMAGE_TAG` را به نسخهٔ قبلی برگردانید و `docker compose up -d`.
4. `migrate` را اجرا کنید (باید no-op باشد) و smoke test بزنید.

> **هرگز** `docker compose down -v` را در تولید اجرا نکنید؛ Volume دیتابیس را حذف می‌کند. هیچ اسکریپتی هم نباید آن را داشته باشد (`ADR-0012`).

---

## ۱۶. لاگ، متریک و پایش

### ۱۶.۱ لاگ‌ها

```bash
docker compose logs -f --tail=200 api
docker compose logs -f --tail=200 worker
docker compose logs --since 30m --no-color api | jq -r 'select(.level=="error")'
docker compose logs --tail=100 postgres
```

لاگ‌ها JSON و ساختاریافته‌اند (`ARCHITECTURE §12`): `requestId`، `orgId`، `userId`، `route`، `latency`؛ هیچ body/PII لاگ نمی‌شود.

### ۱۶.۲ متریک‌ها

`METRICS_ENABLED=true` باعث می‌شود `/metrics` در API فعال شود. دسترسی امن:

```bash
# یک‌بار مصرف
docker compose exec -T api wget -qO- http://127.0.0.1:4000/metrics | head -40

# پایش پیوسته: پروفایل observability (اختیاری) یا Prometheus خارجی
docker compose --profile observability up -d prometheus grafana
ssh -L 3000:127.0.0.1:3000 saman@erp.carexy.shop
```

پروفایل `observability` در Compose وجود دارد: `prometheus` و `grafana` با پورت‌های فقط-loopback (`127.0.0.1:9090` و `127.0.0.1:3000`). برای Prometheus خارجی هم می‌توانید `api:4000/metrics` را در شبکهٔ `backend` scrape کنید. `/metrics` هرگز روی اینترنت عمومی باز نشود.

### ۱۶.۳ پایش منابع میزبان

```bash
docker stats --no-stream
df -h /
du -sh /var/lib/docker/volumes/*
free -h
```

**حدود هشدار** (جزئیات آستانه‌ها در `RUNBOOK.md §3`): دیسک < ۱۵٪ آزاد، مصرف RAM > ۹۰٪، خطای 5xx > ۱٪، اتصال DB > ۸۰٪ `max_connections`، تأخیر outbox > ۶۰ ثانیه، سن بکاپ > ۲۶ ساعت.

---

## ۱۷. عیب‌یابی

| نشانه | علت محتمل | راه‌حل |
|---|---|---|
| `port is already allocated` | پورت ۸۰/۴۴۳/۸۰۸۰ توسط سرویس دیگر گرفته شده | `sudo ss -ltnp \| grep -E ':80\|:443\|:8080'`؛ سرویس متداخل را ببندید یا `WEB_HOST_PORT` را عوض کنید |
| `api` مدام restart می‌شود | خطای اعتبارسنجی env (Zod fail-fast) یا نبود مهاجرت | `docker compose logs api`؛ متغیرهای الزامی را کامل کنید؛ `migrate` را اجرا کنید |
| `/health/ready` = 503 | DB/Redis/S3 در دسترس نیست | `docker compose ps`؛ `logs postgres`؛ صحت `DATABASE_URL`/`REDIS_URL` |
| `password authentication failed for user saman_app` | رمز `.env` با رمز نقش هم‌خوان نیست یا init اجرا نشده | `\du` در psql؛ در Volume موجود init دوباره اجرا نمی‌شود → `ALTER ROLE saman_app PASSWORD ...` |
| `relation "erp.products" does not exist` | مهاجرت اجرا نشده یا با نقش/DB اشتباه | `docker compose --profile tools run --rm migrate`؛ بررسی `MIGRATION_DATABASE_URL` |
| مهاجرت: `permission denied for schema erp` | نقش migrator مالک schema نیست یا `CREATE` ندارد | `ALTER SCHEMA erp OWNER TO saman_migrator;` و `GRANT CREATE ON DATABASE saman TO saman_migrator;` |
| `database "saman" does not exist` | `POSTGRES_DB`/URL غلط | `\l` در psql؛ `.env` را اصلاح و `migrate` را تکرار کنید |
| `minio-init` خطا می‌دهد | تطابق نداشتن کلید برنامه با سیاست یا باکت تکراری | `logs minio-init`؛ `mc admin policy`؛ باکت را با `mc mb --ignore-existing` بسازید |
| `502 Bad Gateway` از Caddy/nginx | `web` یا `api` بالا نیست یا پورت اشتباه است | `docker compose ps`؛ `curl 127.0.0.1:8080/healthz`؛ مطمئن شوید nginx به `api:4000` پروکسی می‌کند |
| کوکی ورود ست نمی‌شود | `COOKIE_SECURE=true` ولی مرورگر روی HTTP است؛ یا `APP_URL` اشتباه | روی HTTPS تست کنید؛ `APP_URL=https://erp.carexy.shop` |
| `CORS error` در مرورگر | `CORS_ORIGINS` با Origin واقعی نمی‌خواند | Origin دقیق (`https://...` بدون `/` انتهایی)؛ در same-origin لازم نیست |
| `429 Too Many Requests` | `RATE_LIMIT_*` برای بار واقعی کم است یا IP پشت پروکسی همه یکی است | `TRUST_PROXY=true`، `X-Forwarded-For` را در nginx بگذارید؛ سقف را واقع‌بینانه تنظیم کنید |
| گواهی TLS صادر نمی‌شود | DNS، پورت ۸۰، یا rate limit Let's Encrypt | `dig erp.carexy.shop`؛ `curl -I http://erp.carexy.shop/.well-known/acme-challenge/test`؛ `logs caddy` |
| صفحهٔ ورود انگلیسی/LTR است | ایمیج `web` قدیمی یا locale اشتباه | `APP_DEFAULT_LOCALE=fa-IR`؛ `docker compose build --no-cache web` و `up -d web` |
| دیسک پر شده | لاگ کانتینر، WAL، بکاپ محلی، پارتیشن‌های قدیمی | `RUNBOOK.md §6` (Disk full playbook) |
| `OOMKilled` در `dmesg` | محدودیت memory کانتینر یا بار زیاد گزارش | limits را واقعی کنید؛ `api`/`worker` را مقیاس دهید؛ `RUNBOOK §7` |
| `job stalled` در BullMQ | worker از کار افتاده یا Redis کند است | `docker compose restart worker`؛ وضعیت Redis؛ `RUNBOOK §4` |
| زمان‌ها جابه‌جا نمایش داده می‌شوند | منطقهٔ زمانی میزبان/مرورگر | `APP_TIMEZONE=Asia/Tehran`؛ ساعت میزبان و مرورگر را چک کنید (ذخیره UTC است) |
| seed تکراری خطا می‌دهد | اجرای هم‌زمان دو seed یا نسخهٔ قدیمی | seed باید idempotent باشد؛ `logs migrate`؛ یکی‌یکی اجرا کنید |

---

## ۱۸. چک‌لیست امنیتی نهایی و ثبت نتیجهٔ نصب

### ۱۸.۱ چک‌لیست پذیرش امنیتی

- [ ] `APP_ENV=production`، `COOKIE_SECURE=true`، `DOCS_ENABLED=false`، `SECURITY_HSTS=true`
- [ ] `JWT_ACCESS_SECRET` تصادفی و قوی است (Refresh Token تصادفی و hash‌شده در `auth_sessions` است، نه JWT)
- [ ] `APP_ENCRYPTION_KEY` تصادفی ۳۲ بایتی و بکاپ آفلاین دارد
- [ ] `BACKUP_ENCRYPTION_PASSPHRASE` تصادفی، Offsite و آفلاین نگهداری می‌شود
- [ ] هیچ رمزی در مخزن Git نیست (`git grep -i 'password\|secret' -- ':!*.md'`)
- [ ] `.env` مجوز ۶۰۰ و مالک `saman`
- [ ] نقش `saman_app` بدون DDL؛ `DATABASE_URL` با آن و `MIGRATION_DATABASE_URL` با `saman_migrator`
- [ ] TLS فعال و `http → https` ریدایرکت می‌شود؛ HSTS ست است
- [ ] پورت‌های دیتابیس/Redis/MinIO/API از بیرون بسته‌اند (`nmap` از بیرون تست کنید)
- [ ] SSH فقط کلید، root ممنوع، UFW فعال
- [ ] `SMS_MODE=limo` فقط با کلید معتبر لیمو؛ در غیر این صورت `mock`
- [ ] بکاپ شبانه فعال، رمزگذاری‌شده، Offsite، و **یک بازیابی آزمایشی موفق ثبت شده**
- [ ] لاگ/متریک در دسترس تیم عملیات است و `/metrics` عمومی نیست
- [ ] کاربران تیم با نقش‌های حداقلی ساخته شده‌اند (تفکیک وظایف، `ADR-0008`)
- [ ] رمز مدیر اول در اولین ورود تغییر کرده و `BOOTSTRAP_ADMIN_*` از `.env` حذف شده
- [ ] صفحهٔ ورود فارسی/RTL تأیید شده است

### ۱۸.۲ ثبت نتیجهٔ نصب (تکمیل توسط نصب‌کننده)

| مورد | مقدار |
|---|---|
| تاریخ (شمسی/میلادی) | |
| نسخهٔ استقرار (`git describe --tags`) | |
| دامنه/URL | |
| نوع دیتابیس (Compose / خارجی) و نام نقش‌ها | |
| نسخهٔ PostgreSQL و اندازهٔ سرور | |
| آخرین مهاجرت اجراشده | |
| زمان رسیدن به صفحهٔ ورود فارسی | |
| نتیجهٔ `/health/ready` | |
| نتیجهٔ `docker compose config -q` | |
| نتیجهٔ تست بکاپ و بازیابی (زمان RTO) | |
| امضای نصب‌کننده | |

---

## پیوست: نمونهٔ کامل `.env`

فایل را با `cp .env.example .env` بسازید و جاهای `<...>` را با خروجی دستورهای بخش ۶.۲ پر کنید. هیچ مقدار محرمانهٔ واقعی در این سند یا در مخزن قرار نمی‌گیرد.

> **تولید:** از ./scripts/gen-secrets.sh استفاده کنید. کلیدهای تاج (JWT، APP_ENCRYPTION_KEY، pepperها، رمز دیتابیس/Redis، مسیر مهاجرت و رمز بکاپ) در ./secrets/ قرار می‌گیرند و در .env تولیدی خالی می‌مانند؛ تنها DATABASE_URL فعلاً رمز نقش برنامه را دارد تا backend مسیر DB_PASSWORD_FILE را تکمیل کند (بند باز در DEPLOYMENT §8.2).

```dotenv
APP_ENV=production
APP_NAME=Saman ERP
APP_PORT=4000
APP_URL=https://erp.carexy.shop
API_PREFIX=api
API_VERSION=v1
APP_TIMEZONE=Asia/Tehran
APP_DEFAULT_LOCALE=fa-IR
DOCS_ENABLED=false
LOG_LEVEL=info

JWT_ACCESS_SECRET=<openssl rand -base64 48>
JWT_ACCESS_TTL=10m
JWT_REFRESH_TTL=7d
APP_ENCRYPTION_KEY=<openssl rand -base64 32>
APP_ENCRYPTION_KEY_VERSION=1
CORS_ORIGINS=https://erp.carexy.shop
COOKIE_SECURE=true
COOKIE_DOMAIN=
TRUST_PROXY=true
SECURITY_HSTS=true
RATE_LIMIT_ENABLED=true
RATE_LIMIT_AUTH_PER_MIN=10
RATE_LIMIT_OTP_PER_HOUR=5
RATE_LIMIT_API_PER_MIN=300
LOGIN_MAX_FAILED=10
LOGIN_LOCK_MINUTES=15

# گزینهٔ الف (دیتابیس داخل Compose) — رمز نقش‌ها فعلاً همان POSTGRES_PASSWORD
DATABASE_URL=postgres://saman_app:<db-hex>@postgres:5432/saman
MIGRATION_DATABASE_URL=postgres://saman_migrator:<db-hex>@postgres:5432/saman
# گزینهٔ ب (دیتابیس خارجی): دو خط بالا را با میزبان واقعی جایگزین و TLS را فعال کنید
# DATABASE_URL=postgres://saman_app:<app-hex>@db.erp.internal:5432/saman
# MIGRATION_DATABASE_URL=postgres://saman_migrator:<migrator-hex>@db.erp.internal:5432/saman
DB_SSL=false
DB_SSL_CA_PATH=
DB_POOL_MAX=20
DB_STATEMENT_TIMEOUT_MS=5000
DB_IDLE_TIMEOUT_MS=30000
DB_MIGRATION_ROLE=saman_migrator
DB_SCHEMA=erp

REDIS_URL=redis://:<redis-hex>@redis:6379/0
REDIS_PASSWORD=<openssl rand -hex 32>
REDIS_PREFIX=saman:
REDIS_TLS=false

S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_BUCKET=saman-files
S3_ACCESS_KEY=saman-app
S3_SECRET_KEY=<openssl rand -hex 32>
S3_FORCE_PATH_STYLE=true
S3_PUBLIC_BASE_URL=
UPLOAD_MAX_MB=20

SMS_MODE=limo
LIMO_BASE_URL=https://api.limosms.com
LIMO_API_KEY=<کلید-پنل-لیمو>
LIMO_SENDER=<شماره-خط>
LIMO_OTP_PATTERN_ID=<شناسه-الگو>
OTP_TTL_SECONDS=120
OTP_MAX_ATTEMPTS=5

CAREXY_API_BASE_URL=https://carexy.shop
CAREXY_API_KEY=<کلید-X-API-KEY-کرکسی>
CAREXY_WEBHOOK_SECRET=<openssl rand -hex 32>
DIGIKALA_API_BASE_URL=https://seller.digikala.com/open-api/v1
DIGIKALA_CLIENT_ID=
DIGIKALA_CLIENT_SECRET=
DIGIKALA_WEBHOOK_SECRET=<openssl rand -hex 32>
CHANNEL_SYNC_ENABLED=true
CHANNEL_STOCK_DEBOUNCE_MS=3000
CHANNEL_HTTP_TIMEOUT_MS=15000

WORKER_CONCURRENCY=10
OUTBOX_BATCH_SIZE=100
OUTBOX_POLL_INTERVAL_MS=1000

METRICS_ENABLED=true
OTEL_ENABLED=false
OTEL_EXPORTER_OTLP_ENDPOINT=
SENTRY_DSN=

BACKUP_ENABLED=true
BACKUP_CRON=0 2 * * *
BACKUP_KEEP_DAYS=30
BACKUP_S3_PREFIX=backups/postgres
BACKUP_ENCRYPTION_PASSPHRASE=<openssl rand -base64 32>

BOOTSTRAP_ADMIN_MOBILE=09121234567
BOOTSTRAP_ADMIN_PASSWORD=<openssl rand -base64 24>
BOOTSTRAP_ORG_NAME=کرکسی شاپ

POSTGRES_USER=saman
POSTGRES_PASSWORD=<openssl rand -hex 32>
POSTGRES_DB=saman
POSTGRES_PORT=5432
REDIS_PORT=6379
MINIO_ROOT_USER=saman
MINIO_ROOT_PASSWORD=<openssl rand -hex 32>
API_HOST_PORT=4000
WEB_HOST_PORT=8080
DOMAIN=erp.carexy.shop
ACME_EMAIL=admin@carexy.shop
IMAGE_TAG=1.0.0
```

**پایان سند — نسخهٔ ۱٫۰**
