import { InDevelopmentState } from '../components/ui/EmptyState';
import { PageHeader } from '../components/ui/PageHeader';
import { useDocumentTitle } from '../lib/hooks';

/**
 * Placeholder screen for sidebar groups whose backend modules are not part of
 * this delivery (procurement, pricing, partners, automation). It explicitly
 * says the feature is under development instead of faking data.
 */
export function ComingSoonPage({ title, description }: { readonly title: string; readonly description?: string }) {
  useDocumentTitle(title);
  return (
    <>
      <PageHeader title={title} />
      <InDevelopmentState
        title="در حال توسعه"
        description={
          description ??
          'ماژول این بخش هنوز در نسخه فعلی سامانه فعال نشده است. پس از تکمیل API، صفحه کامل آن در دسترس قرار می‌گیرد.'
        }
      />
    </>
  );
}
