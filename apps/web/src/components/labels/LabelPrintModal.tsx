/**
 * Printable barcode label dialog.
 *
 * The API renders labels as SVG (never a screenshot), so this component only
 * fetches the endpoints with the in-memory bearer token, previews them and writes
 * a self-contained print document. A popup opened from one click is allowed by
 * popup blockers; the document it receives contains the label images (as
 * `data:` URLs, so no second authenticated request is needed) and a print button.
 *
 * Used by the purchasing screen:
 *   <LabelPrintModal open={open} onClose={close} labelUrls={[receiptLabelsUrl(receipt.id, copies)]} />
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Printer, RefreshCw } from 'lucide-react';

import { getAccessToken } from '../../lib/auth-store';
import { API_BASE } from '../../lib/config';
import { Button, Modal } from '../ui';

export interface LabelPrintModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** SVG endpoints relative to `API_BASE`, in print order (e.g. `receiptLabelsUrl(id)`). */
  readonly labelUrls: readonly string[];
  readonly title?: string;
  readonly description?: string;
}

/** Same document path the API exposes; kept here so callers never hand-build it. */
export function receiptLabelsUrl(receiptId: string, copies = 1): string {
  const safeCopies = Math.min(20, Math.max(1, Math.trunc(Number.isFinite(copies) ? copies : 1)));
  return `/inventory/receipts/${encodeURIComponent(receiptId)}/labels.svg?copies=${safeCopies}`;
}

/** Single-variant label URL (`GET /variants/:variantId/label.svg`). */
export function variantLabelUrl(variantId: string, serial?: string): string {
  const trimmed = serial?.trim() ?? '';
  const query = trimmed.length === 0 ? '' : `?serial=${encodeURIComponent(trimmed)}`;
  return `/variants/${encodeURIComponent(variantId)}/label.svg${query}`;
}

interface LoadedLabel {
  readonly url: string;
  readonly dataUri: string;
  readonly pages: number;
  readonly isSheet: boolean;
}

type LoadState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly labels: readonly LoadedLabel[] }
  | { readonly status: 'error'; readonly message: string };

/** Fetches an SVG with the access token and turns it into an embeddable data URL. */
async function loadLabel(url: string, signal: AbortSignal): Promise<LoadedLabel> {
  const token = getAccessToken();
  const headers: Record<string, string> = { Accept: 'image/svg+xml' };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url.startsWith('http') ? url : `${API_BASE}${url}`, {
    headers,
    credentials: 'include',
    signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const svg = await response.text();
  return {
    url,
    dataUri: svgToDataUri(svg),
    pages: svgPageCount(svg),
    isSheet: /height="[\d.]+mm"/.test(svg),
  };
}

/** Multi-page sheets are `height="<n>mm"`; one label is a fixed 320×180 document. */
function svgPageCount(svg: string): number {
  const match = /<svg[^>]*\bheight="([\d.]+)mm"/.exec(svg);
  const heightMm = match?.[1] === undefined ? 0 : Number(match[1]);
  if (!Number.isFinite(heightMm) || heightMm <= 0) return 1;
  return Math.max(1, Math.round(heightMm / 297));
}

/** UTF-8 safe base64 data URL (an SVG with Persian text is not Latin-1). */
function svgToDataUri(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Self-contained A4 print document: each sheet page is clipped out of one tall image. */
function buildPrintDocument(labels: readonly LoadedLabel[], title: string): string {
  const sections: string[] = [];
  for (const label of labels) {
    if (!label.isSheet) {
      sections.push(
        `<section class="label-page"><img src="${label.dataUri}" alt="${escapeHtml(title)}" /></section>`,
      );
      continue;
    }
    for (let page = 0; page < label.pages; page += 1) {
      sections.push(
        `<section class="sheet-page"><img src="${label.dataUri}" alt="${escapeHtml(title)}" style="top:-${page * 297}mm" /></section>`,
      );
    }
  }
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #ffffff; }
  body { font-family: Tahoma, 'Segoe UI', sans-serif; }
  .toolbar { position: sticky; top: 0; z-index: 10; display: flex; justify-content: center; padding: 10px; background: #f1f5f9; border-bottom: 1px solid #cbd5e1; }
  .toolbar button { padding: 8px 22px; font: inherit; color: #fff; background: #1d4ed8; border: 0; border-radius: 8px; cursor: pointer; }
  .sheet-page { position: relative; width: 210mm; height: 297mm; overflow: hidden; background: #ffffff; page-break-after: always; break-after: page; }
  .sheet-page img { position: absolute; left: 0; width: 210mm; height: auto; }
  .label-page { padding: 12mm; page-break-after: always; break-after: page; }
  .label-page img { display: block; width: 70mm; margin: 0 auto; }
  .sheet-page:last-child, .label-page:last-child { page-break-after: auto; break-after: auto; }
  @media print { .toolbar { display: none; } }
</style>
</head>
<body>
<div class="toolbar"><button type="button" onclick="window.print()">چاپ برچسب‌ها</button></div>
${sections.join('\n')}
</body>
</html>`;
}

/** Opens one blank window synchronously (so popup blockers allow it) and fills it. */
function openPrintWindow(labels: readonly LoadedLabel[], title: string): boolean {
  const printWindow = window.open('', '_blank', 'width=980,height=720');
  if (printWindow === null) return false;
  printWindow.opener = null;
  printWindow.document.open();
  printWindow.document.write(buildPrintDocument(labels, title));
  printWindow.document.close();
  printWindow.focus();
  return true;
}

/** Label preview + print-window launcher used by the purchasing screen. */
export function LabelPrintModal({
  open,
  onClose,
  labelUrls,
  title = 'چاپ برچسب',
  description,
}: LabelPrintModalProps) {
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  const [windowBlocked, setWindowBlocked] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const urlKey = useMemo(
    () =>
      labelUrls
        .map((url) => url.trim())
        .filter((url) => url.length > 0)
        .join('|'),
    [labelUrls],
  );

  useEffect(() => {
    if (!open) return;
    const urls = urlKey.length === 0 ? [] : urlKey.split('|');
    if (urls.length === 0) {
      setState({ status: 'error', message: 'برچسبی برای چاپ انتخاب نشده است.' });
      return;
    }
    const controller = new AbortController();
    setWindowBlocked(false);
    setState({ status: 'loading' });
    void (async () => {
      try {
        const labels: LoadedLabel[] = [];
        for (const url of urls) labels.push(await loadLabel(url, controller.signal));
        if (!controller.signal.aborted) setState({ status: 'ready', labels });
      } catch (error) {
        if (controller.signal.aborted) return;
        const detail = error instanceof Error ? error.message : String(error);
        setState({ status: 'error', message: `دریافت برچسب‌ها ناموفق بود (${detail}).` });
      }
    })();
    return () => controller.abort();
  }, [open, urlKey, attempt]);

  const labels = state.status === 'ready' ? state.labels : [];
  const totalPages = labels.reduce((sum, label) => sum + label.pages, 0);
  const canPrint = state.status === 'ready' && labels.length > 0;

  const handlePrint = useCallback(() => {
    if (!canPrint) return;
    const opened = openPrintWindow(labels, title);
    setWindowBlocked(!opened);
  }, [canPrint, labels, title]);

  const handleRetry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      {...(description === undefined ? {} : { description })}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            بستن
          </Button>
          <Button
            variant="primary"
            icon={<Printer className="size-4" aria-hidden />}
            onClick={handlePrint}
            disabled={!canPrint}
            loading={state.status === 'loading'}
          >
            چاپ
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {state.status === 'loading' && 'در حال آماده‌سازی برچسب‌ها…'}
          {state.status === 'error' && state.message}
          {state.status === 'ready' && `${totalPages.toLocaleString('fa-IR')} صفحه برچسب آماده چاپ است.`}
          {state.status === 'idle' && 'آماده‌سازی برچسب‌ها…'}
        </p>

        {state.status === 'error' && (
          <Button
            variant="outline"
            size="sm"
            icon={<RefreshCw className="size-4" aria-hidden />}
            onClick={handleRetry}
          >
            تلاش دوباره
          </Button>
        )}

        {state.status === 'ready' && (
          <div className="max-h-96 space-y-3 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800">
            {labels.map((label) => (
              <img
                key={label.url}
                src={label.dataUri}
                alt="پیش‌نمایش برچسب"
                className="mx-auto w-full max-w-md rounded border border-slate-300 bg-white"
              />
            ))}
          </div>
        )}

        {windowBlocked && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            مرورگر پنجره چاپ را مسدود کرد؛ اجازه باز شدن پنجره برای این سایت را فعال کنید.
          </p>
        )}

        {state.status === 'ready' && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            پنجره چاپ با تصویر برچسب‌ها و دکمه «چاپ برچسب‌ها» باز می‌شود؛ کاغذ A4 را انتخاب کنید.
          </p>
        )}
      </div>
    </Modal>
  );
}

export default LabelPrintModal;
