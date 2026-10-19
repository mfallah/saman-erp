import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';
import { Textarea } from './Textarea';
import { FormField } from './FormField';

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description?: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly tone?: 'primary' | 'danger';
  readonly loading?: boolean;
  /** Requires a written reason (cancellation, void, rejection flows). */
  readonly requireReason?: boolean;
  readonly reasonLabel?: string;
  readonly onConfirm: (reason?: string) => void;
  readonly onCancel: () => void;
}

/** Confirmation dialog, optionally capturing a mandatory reason. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'تأیید',
  cancelLabel = 'انصراف',
  tone = 'primary',
  loading = false,
  requireReason = false,
  reasonLabel = 'دلیل',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setReason('');
      setTouched(false);
    }
  }, [open]);

  const reasonMissing = requireReason && reason.trim().length < 3 && touched;

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      {...(description === undefined ? {} : { description })}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            loading={loading}
            onClick={() => {
              setTouched(true);
              if (requireReason && reason.trim().length < 3) {
                return;
              }
              onConfirm(requireReason ? reason.trim() : undefined);
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {requireReason && (
        <FormField
          label={reasonLabel}
          htmlFor="confirm-reason"
          required
          {...(reasonMissing ? { error: 'دلیل باید حداقل ۳ نویسه باشد.' } : {})}
        >
          <Textarea
            id="confirm-reason"
            value={reason}
            invalid={reasonMissing}
            onChange={(event) => {
              setReason(event.target.value);
              setTouched(true);
            }}
            placeholder="دلیل این عملیات را بنویسید…"
          />
        </FormField>
      )}
    </Modal>
  );
}
