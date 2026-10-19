import { Link } from '@tanstack/react-router';
import { ArrowRight, SearchX, ShieldX, TriangleAlert } from 'lucide-react';
import { useDocumentTitle } from '../lib/hooks';
import { Button } from '../components/ui/Button';

/** 403 — authenticated but missing the required permission. */
export function ForbiddenPage() {
  useDocumentTitle('دسترسی غیرمجاز');
  return (
    <div className="grid min-h-[60vh] place-items-center text-center">
      <div className="max-w-md">
        <span aria-hidden className="mx-auto mb-3 grid size-14 place-items-center rounded-2xl bg-amber-50 text-amber-600 dark:bg-amber-950">
          <ShieldX className="size-8" />
        </span>
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">دسترسی غیرمجاز</h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          نقش شما اجازه مشاهده این بخش را ندارد. در صورت نیاز با مدیر سامانه تماس بگیرید تا دسترسی لازم را
          به شما بدهد.
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <Link to="/">
            <Button icon={<ArrowRight className="size-4" />}>بازگشت به داشبورد</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

/** 404 — unknown SPA route. */
export function NotFoundPage() {
  useDocumentTitle('صفحه پیدا نشد');
  return (
    <div className="grid min-h-[60vh] place-items-center text-center">
      <div className="max-w-md">
        <span aria-hidden className="mx-auto mb-3 grid size-14 place-items-center rounded-2xl bg-slate-100 text-slate-500 dark:bg-slate-800">
          <SearchX className="size-8" />
        </span>
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">صفحه پیدا نشد</h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          آدرسی که وارد کرده‌اید وجود ندارد یا جابه‌جا شده است.
        </p>
        <div className="mt-4 flex justify-center">
          <Link to="/">
            <Button>بازگشت به داشبورد</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

/** 500 — unexpected render/runtime error inside a route. */
export function ServerErrorPage({ onRetry }: { readonly onRetry?: () => void }) {
  useDocumentTitle('خطای سامانه');
  return (
    <div className="grid min-h-[60vh] place-items-center text-center">
      <div className="max-w-md">
        <span aria-hidden className="mx-auto mb-3 grid size-14 place-items-center rounded-2xl bg-red-50 text-red-600 dark:bg-red-950">
          <TriangleAlert className="size-8" />
        </span>
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">خطای غیرمنتظره</h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          در نمایش این صفحه خطایی رخ داد. می‌توانید دوباره تلاش کنید؛ اگر مشکل ادامه داشت با پشتیبانی تماس
          بگیرید.
        </p>
        <div className="mt-4 flex justify-center gap-2">
          {onRetry !== undefined && <Button onClick={onRetry}>تلاش مجدد</Button>}
          <Link to="/">
            <Button variant="outline">بازگشت به داشبورد</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
