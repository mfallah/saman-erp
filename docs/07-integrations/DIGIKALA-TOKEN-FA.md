# فعال‌سازی توکن دیجی‌کالا — research و راهنمای عملیاتی

> وضعیت: research زنده + پیاده‌سازی
> تاریخ بررسی: ۲۰۲۶-۱۰-۲۲ (۳۱ مهر ۱۴۰۵)
> دامنه: `apps/api` (NestJS) و `apps/web` (React SPA)
> منبع اصلی: پاسخ‌های واقعی سرویس production دیجی‌کالا + مستندات/پروژه‌های جامعه

## ۱. خلاصهٔ یافته‌ها

1. سرویس واقعی زیر `https://seller.digikala.com/open-api/v1` بالا است و نام خود را
   `DK Marketplace OpenAPI Service` با `mode: production` معرفی می‌کند.
2. `POST /open-api/v1/auth/token` وجود دارد (درخواست GET پاسخ `405` می‌دهد).
3. قرارداد واقعی این endpoint فیلد **`authorization_code`** را می‌خواهد، نه `code`،
   نه `validation_code` و نه `client_code` به‌تنهایی:
   - بدنهٔ `{"client_code":"x","validation_code":"y"}` پاسخ `400` داد با خطای
     `authorization_code: «این قسمت نباید خالی باشد»`.
   - بدنهٔ `{"authorization_code":"x"}` پاسخ `400` داد با خطای
     `seller.service.token.authorization.code.invalid`.
   - یعنی سرور ابتدا وجود `authorization_code` را بررسی می‌کند و سپس اعتبار آن را.
4. `GET /auth/scopes/{client_code}` هم `client_code` را الزامی می‌داند؛ پس «کد کلاینت»
   شناسهٔ اپلیکیشن است و بخشی از قرارداد واقعی است.
5. سرویس‌هاب/پنل فروشنده دقیقاً **دو عامل** می‌دهد: «کد کلاینت» و «کد اعتبارسنجی».
   در بررسی production، ارسال `authorization_code` بدون `client_secret` به خطای
   «کد نامعتبر» رسید، نه خطای «client_secret لازم است»؛ بنابراین client secret بخشی از
   این flow نیست و فقط به‌عنوان گزینهٔ پیشرفته/سازگاری نگه داشته می‌شود.
6. کد اعتبارسنجی، متنِ رمزشده با **کلید عمومی ثبت‌شده در پنل دیجی‌کالا** است. فروشنده
   باید آن را base64-decode و با کلید خصوصی متناظر رمزگشایی کند. اگر کلید عمومی ثبت‌شده
   در پنل با کلید خصوصی ذخیره‌شده در سامانه یکی نباشد، رمزگشایی همیشه شکست می‌خورد —
   دقیقاً همان خطای production: `validation code does not match this private key`.
7. الگوریتم padding در مستندات عمومی دیجی‌کالا صریح نیست. پیاده‌سازی باید هر سه حالت را
   امتحان کند: PKCS#1 v1.5، OAEP با SHA-1 و OAEP با SHA-256، با ورودی base64 و
   base64url و فاصله‌های خط‌شده.
8. کد اعتبارسنجی **یک‌بارمصرف و کوتاه‌عمر** است. بعد از هر بار ثبت/تغییر کلید عمومی،
   باید کد تازه از پنل گرفته شود؛ کد قبلی با کلید قبلی رمز شده و دور ریخته می‌شود.

## ۲. قرارداد مشاهده‌شدهٔ endpoint

### `POST /open-api/v1/auth/token`

نمونهٔ درخواست درست (بر اساس contract واقعی):

```http
POST /open-api/v1/auth/token HTTP/1.1
Content-Type: application/json

{
  "authorization_code": "<plaintext validation code after RSA decryption>"
}
```

پاسخ موفق (طبق الگوی متداول OAuth):

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "expires_in": 7200
}
```

پاسخ‌های خطای مشاهده‌شده:

```json
{"status":"error","message":"Validation failed","code":400,
 "errors":{"authorization_code":["این قسمت نباید خالی باشد"]}}
```

```json
{"status":"error","message":"Validation failed","code":400,
 "errors":["seller.service.token.authorization.code.invalid"]}
```

نکتهٔ مهم: در پیاده‌سازی فعلی، بدنه‌های قبلی (`code`, `grant_type`, `client_id`,
`client_secret`) به‌عنوان fallback حفظ شده‌اند، اما بدنه‌های مبتنی بر
`authorization_code` اول امتحان می‌شوند چون contract production همین است.

## ۳. ریشهٔ خطای «validation code does not match this private key»

سه دستهٔ علت، به ترتیب احتمال:

1. **ناهم‌خوانی کلید عمومی و خصوصی** (شایع‌ترین):
   کلید عمومی‌ای که در پنل دیجی‌کالا ثبت شده با private key ذخیره‌شده در
   `erp.channel_credentials` یکی نیست. مثلاً قبلاً جفت‌کلید ساخته شده، بعد کلید خصوصی
   دیگری import شده، یا پنل هنوز کلید قدیمی را نگه داشته است.
2. **کد قدیمی**:
   کد اعتبارسنجی قبل از ثبت کلید عمومی جدید گرفته شده، یا قبلاً یک‌بار مصرف شده است.
3. **ناسازگاری transport/padding**:
   کد با base64url یا خط‌شکن آمده، یا با OAEP-SHA256 (و MGF1) رمز شده که پیاده‌سازی
   قبلی فقط PKCS#1 و OAEP-SHA1 را امتحان می‌کرد.

پیاده‌سازی جدید هر سه را پوشش می‌دهد و در صورت شکست، اثر انگشت کلید عمومی ذخیره‌شده را
در پیام و در `details` پاسخ برمی‌گرداند تا اپراتور بتواند با پنل مقایسه کند.

### محدودیت Node.js برای PKCS#1 v1.5

از Node.js 20.12/22 به بعد، `crypto.privateDecrypt` با `RSA_PKCS1_PADDING` به‌صورت
پیش‌فرض غیرفعال شده است (Marvin attack / CVE-2023-46809) و خطای
`RSA_PKCS1_PADDING is no longer supported for private decryption` می‌دهد. بنابراین
تلاش PKCS#1 در کد فقط برای سازگاری نگه داشته شده و روی Node فعلی همیشه رد می‌شود؛
مسیر واقعی باید OAEP باشد. اگر در عمل مشخص شد دیجی‌کالا PKCS#1 v1.5 استفاده می‌کند،
یا باید از یک پیاده‌سازی pure-JS برای PKCS#1 استفاده شود یا نسخهٔ Node با
`--security-revert=CVE-2023-46809` اجرا شود (توصیه‌نشده).

## ۴. رویهٔ عملیاتی تعویض کلید (operator runbook)

وقتی پیام `DIGIKALA_RSA_DECRYPT_FAILED` با fingerprint دریافت شد:

1. `GET /channel-accounts/:id/rsa-keypair` را صدا بزنید و `publicKeyPem` و
   `fingerprint` را بردارید.
2. اثر انگشت را با کلید عمومی ثبت‌شده در پنل دیجی‌کالا مقایسه کنید. اگر یکی نیست:
   - `POST /channel-accounts/:id/rsa-keypair/reset` را صدا بزنید (جفت‌کلید ۴۰۹۶ بیتی
     جدید می‌سازد و جفت قبلی را overwrite می‌کند).
   - `publicKeyPem` جدید را کامل در پنل دیجی‌کالا (بخش API/احراز هویت فروشنده) ثبت کنید.
3. **بعد از** ثبت کلید، یک «کد اعتبارسنجی» تازه از پنل بگیرید. کد قبلی را دور بریزید.
4. کد کلاینت + کد اعتبارسنجی تازه را در فرم فعال‌سازی وارد کنید و
   `POST /channel-accounts/:id/digikala/token` را صدا بزنید.
5. اگر باز هم شکست خورد، fingerprint پاسخ را دوباره با پنل مقایسه کنید؛ اگر پنل کلید
   را ذخیره نکرده باشد، همان خطا تکرار می‌شود.

نکتهٔ امنیتی: کلید خصوصی هرگز در پاسخ API یا لاگ برنمی‌گردد. فقط کلید عمومی، fingerprint
و وضعیت وجود کلید خصوصی برگردانده می‌شود.

## ۵. تغییرات کد

- `apps/api/src/modules/channels/adapters/digikala/digikala-activation.service.ts`
  - افزودن `RsaDecryptionError` با fingerprint و فهرست تلاش‌ها.
  - پشتیبانی از PKCS#1، OAEP-SHA1 و OAEP-SHA256.
  - نرمال‌سازی base64/base64url و حذف whitespace.
  - افزودن بدنه‌های `authorization_code` به‌عنوان شکل اصلی درخواست.
- `apps/api/src/modules/channels/admin/channels-admin.controller.ts`
  - محاسبهٔ fingerprint کلید ذخیره‌شده و برگرداندن آن در `details` خطای رمزگشایی.
  - endpoint جدید `POST /channel-accounts/:accountId/rsa-keypair/reset` با
    `@Permissions('channel.credential.write')`.
- `apps/api/src/modules/channels/services/channel-accounts.service.ts`
  - `resetRsaKeypair` که جفت‌کلید ۴۰۹۶ بیتی جدید می‌سازد و جفت قبلی را جایگزین می‌کند.
- `apps/web/src/pages/ChannelsPage.tsx`
  - دو ورودی اصلی: کد کلاینت + کد اعتبارسنجی.
  - client secret داخل `<details>` با عنوان «پیشرفته (اختیاری)».
  - هشدار مقایسهٔ fingerprint + دکمهٔ «تولید مجدد جفت‌کلید» + نمایش کلید عمومی جدید
    و دستور گرفتن کد تازه.

## ۶. منابع

منابع اولیه/زنده (بررسی مستقیم در ۲۰۲۶-۱۰-۲۲):

- ریشهٔ سرویس: <https://seller.digikala.com/open-api/v1/> — پاسخ `200` با
  `{"status":"ok","data":{"name":"DK Marketplace OpenAPI Service","mode":"production",...}}`.
- endpoint توکن: <https://seller.digikala.com/open-api/v1/auth/token> — GET `405`،
  POST با `authorization_code` نامعتبر `400` و خطای
  `seller.service.token.authorization.code.invalid`.
- endpoint scopes: <https://seller.digikala.com/open-api/v1/auth/scopes/{client_code}> —
  بدون `client_code` خطای validation می‌دهد.

منابع جامعه/مستندات:

- Digikala Seller Service Sandbox (نمونهٔ رسمی/جامعه برای شبیه‌سازی API فروشندگان):
  <https://github.com/salimousavi/seller_service_sandbox>
- کتابخانهٔ PHP دیجی‌کالا با واژگان `authorization code` و refresh token:
  <https://github.com/yeganehha/digikala-seller-open-api>
- راهنمای فعال‌سازی توکن در پنل (سرویس‌هاب/پشتیبانی):
  <http://selleryar.com/wp-content/uploads/2023/07/DK-Token-Request.pdf>
- توضیح سرویس‌هاب به‌عنوان درگاه رسمی اتصال سیستم‌های بیرونی و عمر کوتاه توکن:
  <https://nikanwp.ir/digikala-woocommerce-integration/>
- فهرست endpointها و مسیر `auth/revoke` و `auth/scopes/{client_code}`:
  <https://clawhub.ai/ehsanghaffar/skills/digikala>
- محدودیت Node.js در رمزگشایی PKCS#1 v1.5:
  <https://github.com/nodejs/node/issues/55628>
  و commit رسمی:
  <https://github.com/nodejs/node/commit/d3d357ab09>

> هشدار: این سرویس production است. در تحقیق فقط درخواست‌های خواندنی و بدنه‌های
> نامعتبرِ بدون اعتبارنامه ارسال شد؛ هیچ داده‌ای تغییر نکرد و هیچ توکن واقعی لاگ نشد.
