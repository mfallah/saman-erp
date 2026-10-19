import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus, Save, Trash2 } from 'lucide-react';
import { api, newRequestId, toFaErrorMessage, uploadFile } from '../lib/api-client';
import { useDocumentTitle } from '../lib/hooks';
import { queryKeys } from '../lib/query-keys';
import type { Brand, CategoryNode, ProductDetail, Unit } from '../types/api';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { Combobox, type ComboboxOption } from '../components/ui/Combobox';
import { ErrorState } from '../components/ui/ErrorState';
import { FileDropzone, type UploadedFileItem } from '../components/ui/FileDropzone';
import { FormField } from '../components/ui/FormField';
import { IconButton } from '../components/ui/IconButton';
import { Input } from '../components/ui/Input';
import { PageHeader } from '../components/ui/PageHeader';
import { Select } from '../components/ui/Select';
import { Textarea } from '../components/ui/Textarea';
import { useToast } from '../components/ui/Toast';

const variantSchema = z.object({
  sku: z.string().trim().min(1, 'شناسه تنوع (SKU) الزامی است.'),
  barcode: z.string().trim().optional(),
  unitId: z.string().min(1, 'واحد اندازه‌گیری را انتخاب کنید.'),
});

const productSchema = z.object({
  nameFa: z.string().trim().min(2, 'نام فارسی کالا حداقل ۲ نویسه است.'),
  nameEn: z.string().trim().optional(),
  categoryId: z.string().min(1, 'دسته‌بندی را انتخاب کنید.'),
  brandId: z.string().optional(),
  description: z.string().trim().optional(),
  variants: z.array(variantSchema).min(1, 'حداقل یک تنوع (SKU) لازم است.'),
});
type ProductForm = z.infer<typeof productSchema>;

function flattenCategories(nodes: readonly CategoryNode[], depth = 0): ComboboxOption[] {
  return nodes.flatMap((node) => [
    { value: node.id, label: `${'— '.repeat(depth)}${node.nameFa ?? node.name ?? node.code ?? 'دسته'}` },
    ...flattenCategories(node.children ?? [], depth + 1),
  ]);
}

/** Create a product with variants and media (POST /products). */
export function ProductNewPage() {
  useDocumentTitle('کالای جدید');
  const navigate = useNavigate();
  const toast = useToast();
  const [mediaFiles, setMediaFiles] = useState<readonly UploadedFileItem[]>([]);
  const [uploading, setUploading] = useState(false);

  const categoriesQuery = useQuery({
    queryKey: queryKeys.catalog.categories,
    queryFn: () => api.get<readonly CategoryNode[]>('/categories', { tree: true }),
    staleTime: 5 * 60_000,
  });
  const brandsQuery = useQuery({
    queryKey: queryKeys.catalog.brands,
    queryFn: () => api.get<readonly Brand[]>('/brands', { perPage: 200 }),
    staleTime: 5 * 60_000,
  });
  const unitsQuery = useQuery({
    queryKey: queryKeys.catalog.units,
    queryFn: () => api.get<readonly Unit[]>('/units', { perPage: 200 }),
    staleTime: 5 * 60_000,
  });

  const form = useForm<ProductForm>({
    resolver: zodResolver(productSchema),
    defaultValues: {
      nameFa: '',
      nameEn: '',
      categoryId: '',
      brandId: '',
      description: '',
      variants: [{ sku: '', barcode: '', unitId: '' }],
    },
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'variants' });

  const categoryOptions = flattenCategories(categoriesQuery.data ?? []);
  const brandOptions = (brandsQuery.data ?? []).map((brand) => ({
    value: brand.id,
    label: brand.nameFa ?? brand.name ?? brand.id,
  }));
  const unitOptions = (unitsQuery.data ?? []).map((unit) => ({
    value: unit.id,
    label: unit.nameFa ?? unit.symbol ?? unit.id,
  }));

  const createMutation = useMutation({
    mutationFn: (values: ProductForm) =>
      api.post<ProductDetail>(
        '/products',
        {
          nameFa: values.nameFa,
          ...(values.nameEn === undefined || values.nameEn === '' ? {} : { nameEn: values.nameEn }),
          categoryId: values.categoryId,
          ...(values.brandId === undefined || values.brandId === '' ? {} : { brandId: values.brandId }),
          ...(values.description === undefined || values.description === ''
            ? {}
            : { description: values.description }),
          variants: values.variants.map((variant) => ({
            sku: variant.sku,
            ...(variant.barcode === undefined || variant.barcode === ''
              ? {}
              : { barcode: variant.barcode }),
            unitId: variant.unitId,
          })),
          ...(mediaFiles.length === 0 ? {} : { mediaFileIds: mediaFiles.map((file) => file.id) }),
          status: 'draft',
        },
        { idempotencyKey: newRequestId() },
      ),
    onSuccess: (product) => {
      toast.success('کالا ثبت شد', 'کالای جدید با موفقیت ایجاد شد.');
      void navigate({ to: '/products/$id', params: { id: product.id } });
    },
    onError: (error) => {
      toast.error('ثبت کالا ناموفق بود', toFaErrorMessage(error));
    },
  });

  const handleUpload = async (files: readonly File[]): Promise<void> => {
    setUploading(true);
    try {
      const uploaded: UploadedFileItem[] = [];
      for (const file of files) {
        const result = await uploadFile(file, 'product_media');
        uploaded.push({ id: result.id, name: result.fileName, ...(result.sizeBytes === undefined ? {} : { sizeBytes: result.sizeBytes }) });
      }
      setMediaFiles((current) => [...current, ...uploaded]);
      toast.success('فایل بارگذاری شد', 'فایل با موفقیت در فضای ذخیره‌سازی قرار گرفت.');
    } catch (error) {
      toast.error('بارگذاری فایل ناموفق بود', toFaErrorMessage(error));
    } finally {
      setUploading(false);
    }
  };

  const referenceError = categoriesQuery.isError || unitsQuery.isError;

  return (
    <>
      <PageHeader
        title="کالای جدید"
        description="اطلاعات پایه، تنوع‌ها و رسانه کالا را ثبت کنید"
        breadcrumbs={[{ label: 'محصولات', to: '/products' }, { label: 'کالای جدید' }]}
        actions={
          <Button
            type="submit"
            form="product-form"
            loading={createMutation.isPending}
            icon={<Save className="size-4" />}
            disabled={referenceError}
          >
            ذخیره کالا
          </Button>
        }
      />

      {referenceError && (
        <div className="mb-4">
          <ErrorState
            title="بارگذاری اطلاعات پایه ناموفق بود"
            message="برای ثبت کالا، دسته‌بندی‌ها و واحدهای اندازه‌گیری باید از سرور دریافت شوند."
            onRetry={() => {
              void categoriesQuery.refetch();
              void unitsQuery.refetch();
            }}
          />
        </div>
      )}

      <form
        id="product-form"
        noValidate
        onSubmit={form.handleSubmit((values) => createMutation.mutate(values))}
        className="space-y-4"
      >
        <Card>
          <CardHeader title="اطلاعات پایه" />
          <div className="grid gap-4 md:grid-cols-2">
            <FormField
              label="نام فارسی"
              htmlFor="product-name-fa"
              required
              {...(form.formState.errors.nameFa === undefined
                ? {}
                : { error: form.formState.errors.nameFa.message })}
            >
              <Input
                id="product-name-fa"
                invalid={form.formState.errors.nameFa !== undefined}
                {...form.register('nameFa')}
              />
            </FormField>
            <FormField label="نام انگلیسی" htmlFor="product-name-en" hint="اختیاری">
              <Input id="product-name-en" dir="ltr" className="text-left" {...form.register('nameEn')} />
            </FormField>
            <FormField
              label="دسته‌بندی"
              required
              {...(form.formState.errors.categoryId === undefined
                ? {}
                : { error: form.formState.errors.categoryId.message })}
            >
              <Combobox
                options={categoryOptions}
                value={form.watch('categoryId')}
                onChange={(value) => form.setValue('categoryId', value, { shouldValidate: true })}
                loading={categoriesQuery.isLoading}
                disabled={categoriesQuery.isError}
                placeholder="انتخاب دسته‌بندی"
                invalid={form.formState.errors.categoryId !== undefined}
                ariaLabel="دسته‌بندی کالا"
              />
            </FormField>
            <FormField label="برند" hint="اختیاری">
              <Combobox
                options={brandOptions}
                value={form.watch('brandId') ?? ''}
                onChange={(value) => form.setValue('brandId', value)}
                loading={brandsQuery.isLoading}
                placeholder="انتخاب برند"
                ariaLabel="برند کالا"
              />
            </FormField>
            <FormField label="توضیحات" htmlFor="product-description" className="md:col-span-2">
              <Textarea id="product-description" rows={3} {...form.register('description')} />
            </FormField>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="تنوع‌ها (SKU)"
            description="هر کالا حداقل یک تنوع دارد؛ بارکد اختیاری است."
            actions={
              <Button
                variant="outline"
                size="sm"
                onClick={() => append({ sku: '', barcode: '', unitId: '' })}
                icon={<Plus className="size-4" />}
              >
                افزودن تنوع
              </Button>
            }
          />
          <div className="space-y-3">
            {fields.map((field, index) => (
              <div
                key={field.id}
                className="grid items-end gap-3 rounded-lg border border-slate-200 p-3 md:grid-cols-[1fr_1fr_1fr_auto] dark:border-slate-700"
              >
                <FormField
                  label={`شناسه تنوع ${index + 1}`}
                  required
                  {...(form.formState.errors.variants?.[index]?.sku === undefined
                    ? {}
                    : { error: form.formState.errors.variants[index]?.sku?.message })}
                >
                  <Input
                    dir="ltr"
                    className="text-left"
                    placeholder="SKU-001"
                    invalid={form.formState.errors.variants?.[index]?.sku !== undefined}
                    {...form.register(`variants.${index}.sku`)}
                  />
                </FormField>
                <FormField label="بارکد" hint="اختیاری">
                  <Input
                    dir="ltr"
                    className="text-left"
                    placeholder="6260000000000"
                    {...form.register(`variants.${index}.barcode`)}
                  />
                </FormField>
                <FormField
                  label="واحد"
                  required
                  {...(form.formState.errors.variants?.[index]?.unitId === undefined
                    ? {}
                    : { error: form.formState.errors.variants[index]?.unitId?.message })}
                >
                  <Select
                    options={unitOptions}
                    placeholder="انتخاب واحد"
                    invalid={form.formState.errors.variants?.[index]?.unitId !== undefined}
                    {...form.register(`variants.${index}.unitId`)}
                  />
                </FormField>
                <IconButton
                  label={`حذف تنوع ${index + 1}`}
                  tone="danger"
                  icon={<Trash2 className="size-4" />}
                  disabled={fields.length === 1}
                  onClick={() => remove(index)}
                />
              </div>
            ))}
            {form.formState.errors.variants?.root?.message !== undefined && (
              <p role="alert" className="text-xs text-red-600">
                {form.formState.errors.variants.root.message}
              </p>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="رسانه" description="تصاویر کالا (حداکثر ۱۰ مگابایت برای هر فایل)" />
          <FileDropzone
            label="انتخاب تصویر کالا"
            accept="image/*"
            files={mediaFiles}
            uploading={uploading}
            onRemove={(id) => setMediaFiles((current) => current.filter((file) => file.id !== id))}
            onFiles={(files) => void handleUpload(files)}
          />
        </Card>
      </form>
    </>
  );
}
