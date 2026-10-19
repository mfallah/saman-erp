### 6.3 Iranian 6-level chart of accounts (exact seed manifest)

**v1.1 rewrite (R1-A B-04/B-05, R1-D B-04):** the seed is now an exact, executable manifest with every mandatory column, asserted counts, explicit contra rows and no placeholder codes. Inheritance rule keeps it compact: a row's `account_type` is inherited from its L1 group (`1=asset, 2=liability, 3=equity, 4=income, 5=expense`); `normal_balance` is inherited from L2 unless the row is listed in the contra override table; `nature='operational'` unless listed as contra; `is_postable=true` for **all L4** rows (and for L5/L6 rows created per cost center/project), `false` for L1–L3. Every row: `organization_id=1`, `currency='IRR'`, `deleted_at=NULL`, `is_active=true`. Each row's `parent_id` is resolved by code.

**Asserted counts** (CI: `erp.validate_coa_seed()`): L1 **5**, L2 **10**, L3 **59**, L4 **85**, L5 templates **8**, L6 templates **6** → **173 manifest rows**. Postable accounts: 85 permanent + 14 templates.

#### L1 — groups (5)

| code | name_fa | account_type | normal_balance | nature |
|---|---|---|---|---|
| `1` | دارایی‌ها | asset | debit | operational |
| `2` | بدهی‌ها | liability | credit | operational |
| `3` | حقوق صاحبان سرمایه | equity | credit | operational |
| `4` | درآمدها | income | credit | operational |
| `5` | هزینه‌ها | expense | debit | operational |

#### L2 — کل (10)

| code | name_fa | parent | normal_balance |
|---|---|---|---|
| `1-1` | دارایی‌های جاری | 1 | debit |
| `1-2` | دارایی‌های غیرجاری | 1 | debit |
| `2-1` | بدهی‌های جاری | 2 | credit |
| `2-2` | بدهی‌های بلندمدت | 2 | credit |
| `3-1` | سرمایه | 3 | credit |
| `3-2` | سود و اندوخته | 3 | credit |
| `4-1` | درآمد عملیاتی | 4 | credit |
| `4-2` | سایر درآمدها | 4 | credit |
| `5-1` | بهای تمام‌شده کالای فروش‌رفته و ضایعات | 5 | debit |
| `5-2` | هزینه‌های عملیاتی | 5 | debit |

#### Contra overrides (explicit; `nature='contra'`, opposite normal side)

| code | name_fa | parent | account_type | normal_balance | why |
|---|---|---|---|---|---|
| `1-2-02` | استهلاک انباشته دارایی‌های ثابت | 1-2 | asset | **credit** | contra-asset |
| `3-1-02` | سرمایه پرداخت‌نشده | 3-1 | equity | **debit** | contra-equity |
| `4-1-02` | برگشت از فروش | 4-1 | income | **debit** | contra-revenue |
| `4-1-03` | تخفیفات فروش | 4-1 | income | **debit** | contra-revenue |
| `1-1-03-003` | ذخیره مطالبات مشکوک‌الوصول | 1-1-03 | asset | **credit** | contra-asset (L4) |
| `2-1-08-001` | سود سهام پرداختنی | 2-1-08 | liability | credit | normal (not contra; listed for explicitness) |
| `1-1-09` | حساب تسویه کانال‌های فروش | 1-1 | asset | debit | clearing asset (normal) |
| `2-1-12` | حساب‌های تسویه درگاه پرداخت | 2-1 | liability | credit | clearing liability (normal) |

CI test: every row with `nature='contra'` must have `normal_balance` opposite its group's natural side (`erp.assert_contra_signs()`).

#### L3 — معین (59 rows)

| code | name_fa | parent | normal_balance | nature |
|---|---|---|---|---|
| `1-1-01` | موجودی نقد و بانک | 1-1 | debit | operational |
| `1-1-02` | سرمایه‌گذاری‌های کوتاه‌مدت | 1-1 | debit | operational |
| `1-1-03` | حساب‌های دریافتنی تجاری | 1-1 | debit | operational |
| `1-1-04` | موجودی کالا | 1-1 | debit | operational |
| `1-1-05` | پیش‌پرداخت‌ها و علی‌الحساب | 1-1 | debit | operational |
| `1-1-06` | مالیات بر ارزش افزوده دریافتنی (اعتبار مالیاتی) | 1-1 | debit | operational |
| `1-1-07` | چک‌های دریافتنی | 1-1 | debit | operational |
| `1-1-08` | حساب‌های دریافتنی از کانال‌های فروش | 1-1 | debit | operational |
| `1-1-09` | حساب تسویه کانال‌های فروش (clearing) | 1-1 | debit | operational |
| `1-1-10` | موجودی کالای در راه و امانی | 1-1 | debit | operational |
| `1-2-01` | دارایی‌های ثابت مشهود | 1-2 | debit | operational |
| `1-2-02` | استهلاک انباشته دارایی‌های ثابت | 1-2 | credit | **contra** |
| `1-2-03` | دارایی‌های نامشهود | 1-2 | debit | operational |
| `1-2-04` | سرمایه‌گذاری‌های بلندمدت | 1-2 | debit | operational |
| `1-2-05` | استهلاک انباشته دارایی‌های نامشهود | 1-2 | credit | **contra** |
| `2-1-01` | حساب‌های پرداختنی تجاری | 2-1 | credit | operational |
| `2-1-02` | اسناد پرداختنی | 2-1 | credit | operational |
| `2-1-03` | معوقات بیمه | 2-1 | credit | operational |
| `2-1-04` | معوقات مالیات بر درآمد | 2-1 | credit | operational |
| `2-1-05` | مالیات بر ارزش افزوده پرداختنی (خروجی) | 2-1 | credit | operational |
| `2-1-06` | پیش‌دریافت از مشتریان | 2-1 | credit | operational |
| `2-1-07` | حقوق و دستمزد پرداختنی | 2-1 | credit | operational |
| `2-1-08` | سود سهام پرداختنی | 2-1 | credit | operational |
| `2-1-09` | چک‌های پرداختنی | 2-1 | credit | operational |
| `2-1-10` | پرداختنی کارمزد کانال‌های فروش | 2-1 | credit | operational |
| `2-1-11` | کالای دریافت‌شده بدون فاکتور (GRNI) | 2-1 | credit | operational |
| `2-1-12` | حساب‌های تسویه درگاه پرداخت (POS/درگاه/COD) | 2-1 | credit | operational |
| `2-1-13` | مالیات تکلیفی پرداختنی | 2-1 | credit | operational |
| `2-2-01` | وام‌ها و تسهیلات بانکی بلندمدت | 2-2 | credit | operational |
| `2-2-02` | بدهی‌های سنواتی کارکنان | 2-2 | credit | operational |
| `3-1-01` | سرمایه ثبت‌شده | 3-1 | credit | operational |
| `3-1-02` | سرمایه پرداخت‌نشده | 3-1 | debit | **contra** |
| `3-2-01` | سود (زیان) انباشته | 3-2 | credit | operational |
| `3-2-02` | اندوخته قانونی | 3-2 | credit | operational |
| `3-2-03` | سایر اندوخته‌ها | 3-2 | credit | operational |
| `3-2-04` | سود (زیان) دوره جاری | 3-2 | credit | operational |
| `3-2-05` | تعدیلات سنواتی | 3-2 | credit | operational |
| `4-1-01` | فروش کالا | 4-1 | credit | operational |
| `4-1-02` | برگشت از فروش | 4-1 | debit | **contra** |
| `4-1-03` | تخفیفات فروش | 4-1 | debit | **contra** |
| `4-1-04` | درآمد حمل و ارسال (بازپرداخت‌شده) | 4-1 | credit | operational |
| `4-2-01` | سود سپرده‌های بانکی | 4-2 | credit | operational |
| `4-2-02` | اضافه صندوق و درآمد متفرقه | 4-2 | credit | operational |
| `5-1-01` | بهای تمام‌شده کالای فروخته‌شده (COGS) | 5-1 | debit | operational |
| `5-1-02` | کسری شمارش انبار | 5-1 | debit | operational |
| `5-1-03` | ضایعات و دمیج انبار | 5-1 | debit | operational |
| `5-2-01` | هزینه‌های حمل و نقل | 5-2 | debit | operational |
| `5-2-02` | هزینه بسته‌بندی | 5-2 | debit | operational |
| `5-2-03` | کارمزد پلتفرم‌ها و درگاه‌ها | 5-2 | debit | operational |
| `5-2-04` | تبلیغات و بازاریابی | 5-2 | debit | operational |
| `5-2-05` | هزینه‌های پرسنلی | 5-2 | debit | operational |
| `5-2-06` | هزینه استهلاک | 5-2 | debit | operational |
| `5-2-07` | هزینه‌های مالی و بانکی | 5-2 | debit | operational |
| `5-2-08` | هزینه مالیات بر درآمد | 5-2 | debit | operational |
| `5-2-09` | اجاره | 5-2 | debit | operational |
| `5-2-10` | هزینه متفرقه | 5-2 | debit | operational |
| `5-2-11` | هزینه مطالبات مشکوک‌الوصول | 5-2 | debit | operational |
| `5-2-12` | کسری صندوق | 5-2 | debit | operational |
| `5-2-13` | تفاوت تسویه کانال‌ها | 5-2 | debit | operational |
| `5-2-14` | تفاوت گرد کردن و باقیمانده توزیع | 5-2 | debit | operational |

*(59 rows; `1-1-10` carries the old `1-1-04-002` in-transit role at L3 and is postable only via its L4 children.)*

#### L4 — تفصیلی, postable (85 rows; all `is_postable=true`)

Rule: `account_type`/`normal_balance` inherited from the L3 parent; only `1-1-03-003` is contra (credit). Listing is `code name_fa` (parent = code minus last segment). Fenced block is directly parseable by the seed generator.

```text
1-1-01-001 صندوق مرکزی
1-1-01-002 بانک‌ها - حساب اصلی
1-1-01-003 صندوق فروشگاه
1-1-01-004 حساب واسط درگاه پرداخت (در انتظار تسویه)
1-1-01-005 حساب واسط POS و پرداخت در محل
1-1-02-001 سپرده سرمایه‌گذاری کوتاه‌مدت
1-1-03-001 دریافتنی از مشتریان
1-1-03-002 اسناد دریافتنی
1-1-03-003 ذخیره مطالبات مشکوک‌الوصول
1-1-03-004 دریافتنی از مشتریان - اعتباری
1-1-04-001 موجودی کالای بازرگانی
1-1-04-002 موجودی کالای در جریان ساخت/بسته‌بندی
1-1-05-001 پیش‌پرداخت به تأمین‌کنندگان
1-1-05-002 علی‌الحساب کارکنان
1-1-06-001 مالیات بر ارزش افزوده دریافتنی
1-1-06-002 اعتبار مالیاتی صادرات
1-1-07-001 چک‌های دریافتنی نزد صندوق
1-1-07-002 چک‌های دریافتنی در جریان وصول (در جریان)
1-1-08-001 دریافتنی از دیجی‌کالا
1-1-08-002 دریافتنی از کرکسی
1-1-08-003 دریافتنی از اسنپ‌شاپ
1-1-08-004 دریافتنی از تپسی‌شاپ
1-1-09-001 تسویه در جریان کانال‌ها
1-1-09-002 وجه در راه کانال‌ها
1-1-10-001 موجودی کالای در راه
1-1-10-002 موجودی کالای امانی نزد کانال
1-2-01-001 زمین
1-2-01-002 ساختمان
1-2-01-003 ماشین‌آلات و تجهیزات
1-2-01-004 وسایل نقلیه
1-2-01-005 رایانه و تجهیزات اداری
1-2-02-001 استهلاک انباشته ساختمان
1-2-02-002 استهلاک انباشته تجهیزات
1-2-03-001 نرم‌افزار و لایسنس
1-2-04-001 سرمایه‌گذاری بلندمدت
1-2-05-001 استهلاک انباشته دارایی‌های نامشهود
2-1-01-001 پرداختنی به تأمین‌کنندگان
2-1-01-002 اسناد پرداختنی
2-1-01-003 پرداختنی به کانال‌های فروش
2-1-02-001 اسناد پرداختنی بلندمدت
2-1-03-001 بیمه تأمین اجتماعی پرداختنی
2-1-04-001 مالیات بر درآمد پرداختنی
2-1-05-001 مالیات بر ارزش افزوده پرداختنی
2-1-06-001 پیش‌دریافت از مشتریان
2-1-07-001 حقوق و دستمزد پرداختنی
2-1-08-001 سود سهام پرداختنی
2-1-09-001 چک‌های پرداختنی
2-1-10-001 پرداختنی کارمزد کانال‌ها
2-1-11-001 GRNI - کالای دریافت‌شده بدون فاکتور
2-1-12-001 تسویه درگاه پرداخت اینترنتی
2-1-12-002 تسویه POS
2-1-12-003 تسویه پرداخت در محل (COD)
2-1-13-001 مالیات تکلیفی پرداختنی
2-2-01-001 تسهیلات بانکی بلندمدت
2-2-02-001 ذخیره سنوات کارکنان
3-1-01-001 سرمایه ثبت‌شده
3-1-02-001 سرمایه پرداخت‌نشده
3-2-01-001 سود انباشته
3-2-02-001 اندوخته قانونی
3-2-03-001 سایر اندوخته‌ها
3-2-04-001 سود (زیان) دوره جاری
3-2-05-001 تعدیلات سنواتی
4-1-01-001 فروش از سایت اختصاصی (کرکسی)
4-1-01-002 فروش از دیجی‌کالا
4-1-01-003 فروش از اسنپ‌شاپ
4-1-01-004 فروش از تپسی‌شاپ
4-1-01-005 فروش حضوری/POS
4-1-02-001 برگشت از فروش
4-1-03-001 تخفیفات فروش
4-1-04-001 درآمد حمل و ارسال
4-2-01-001 سود سپرده بانکی
4-2-02-001 اضافه صندوق
4-2-02-002 درآمد متفرقه
5-1-01-001 بهای تمام‌شده کالای فروش‌رفته
5-1-02-001 کسری شمارش انبار
5-1-02-002 اضافه شمارش انبار (درآمد)
5-1-03-001 ضایعات انبار
5-1-03-002 دمیج و خرابی
5-2-01-001 هزینه حمل و نقل
5-2-02-001 هزینه بسته‌بندی
5-2-03-001 کارمزد دیجی‌کالا
5-2-03-002 کارمزد کرکسی/درگاه
5-2-03-003 کارمزد اسنپ‌شاپ/تپسی‌شاپ
5-2-04-001 هزینه تبلیغات
5-2-05-001 هزینه حقوق و مزایا
5-2-06-001 هزینه استهلاک
5-2-07-001 هزینه‌های بانکی
5-2-08-001 هزینه مالیات بر درآمد
5-2-09-001 اجاره
5-2-10-001 هزینه متفرقه
5-2-11-001 هزینه مطالبات مشکوک‌الوصول
5-2-12-001 کسری صندوق
5-2-13-001 تفاوت تسویه کانال‌ها
5-2-14-001 تفاوت گرد کردن و باقیمانده
```

Count check: the fence must contain exactly 85 lines; `erp.validate_coa_seed()` asserts this.

#### L5 — cost-center templates (8; `account_level=5`, parent = the L4 account they extend)

`01` انبار مرکزی، `02` فروش، `03` بازاریابی، `04` مالی، `05` اداری، `06` فناوری اطلاعات، `07` پشتیبانی مشتریان، `08` عمومی. Materialized lazily by `AccountingService.ensureCostCenterAccount(accountId, costCenterId)` → code `<L4>-<cc>`, `parent_id=L4`, `is_postable=true`, `account_level=5`.

#### L6 — project templates (6; `account_level=6`, parent = the **L5** row, not L4 — R1-D B-04)

`001` توسعه فروشگاه، `002` راه‌اندازی انبار جدید، `003` یکپارچه‌سازی کانال، `004` پروژه حسابداری، `005` بهبود فرایند، `006` بدون پروژه. Materialized lazily: code `<L5>-<project>`, parent `L5` row.
