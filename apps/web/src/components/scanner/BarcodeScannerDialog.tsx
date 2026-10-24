/**
 * Camera barcode scanner dialog.
 *
 * Uses the native `BarcodeDetector` API (Chrome/Edge on Android and desktop
 * Chrome with the flag) so no external WASM dependency is bundled. When the API
 * or camera is unavailable it degrades to a manual code field instead of a dead
 * button, which matters on iOS Safari.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, CameraOff, Keyboard } from 'lucide-react';

import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';

type DetectorLike = {
  detect: (source: CanvasImageSource) => Promise<readonly { rawValue: string }[]>;
};

type DetectorCtor = new (options?: { formats?: readonly string[] }) => DetectorLike;

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'] as const;

function getDetectorCtor(): DetectorCtor | null {
  const candidate = (globalThis as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
  return typeof candidate === 'function' ? candidate : null;
}

export interface BarcodeScannerDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onDetected: (code: string) => void;
  readonly title?: string;
}

export function BarcodeScannerDialog({ open, onClose, onDetected, title = 'اسکن بارکد با دوربین' }: BarcodeScannerDialogProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stoppedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  const [torchOn, setTorchOn] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [scanning, setScanning] = useState(false);

  const stop = useCallback(() => {
    stoppedRef.current = true;
    const stream = streamRef.current;
    if (stream !== null) {
      for (const track of stream.getTracks()) track.stop();
      streamRef.current = null;
    }
    setScanning(false);
  }, []);

  useEffect(() => {
    if (!open) {
      stop();
      return;
    }
    stoppedRef.current = false;
    setError(null);
    setManual('');
    const ctor = getDetectorCtor();
    if (ctor === null) {
      setError('مرورگر شما از تشخیص خودکار بارکد پشتیبانی نمی‌کند؛ کد را دستی وارد کنید یا از Chrome استفاده کنید.');
      return;
    }
    if (navigator.mediaDevices?.getUserMedia === undefined) {
      setError('دسترسی به دوربین در این مرورگر ممکن نیست؛ کد را دستی وارد کنید.');
      return;
    }

    let detector: DetectorLike | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      if (stoppedRef.current) return;
      const video = videoRef.current;
      if (video !== null && detector !== null && video.readyState >= 2) {
        try {
          const codes = await detector.detect(video);
          const value = codes[0]?.rawValue?.trim() ?? '';
          if (value.length > 0 && !stoppedRef.current) {
            stoppedRef.current = true;
            if (navigator.vibrate !== undefined) navigator.vibrate(80);
            onDetected(value);
            onClose();
            return;
          }
        } catch {
          // Transient detection errors are normal while the frame warms up.
        }
      }
      timer = setTimeout(() => void tick(), 250);
    };

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (stoppedRef.current) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video !== null) {
          video.srcObject = stream;
          await video.play().catch(() => undefined);
        }
        detector = new ctor({ formats: FORMATS });
        const track = stream.getVideoTracks()[0];
        const capabilities = track?.getCapabilities() as { torch?: boolean } | undefined;
        setTorchAvailable(capabilities?.torch === true);
        setScanning(true);
        timer = setTimeout(() => void tick(), 400);
      } catch (cause) {
        const name = cause instanceof DOMException ? cause.name : '';
        setError(
          name === 'NotAllowedError'
            ? 'اجازهٔ دسترسی به دوربین داده نشد. از تنظیمات مرورگر اجازه بده یا کد را دستی وارد کن.'
            : name === 'NotFoundError'
              ? 'دوربینی پیدا نشد؛ کد را دستی وارد کن.'
              : 'بازکردن دوربین ناموفق بود؛ کد را دستی وارد کن.',
        );
      }
    })();

    return () => {
      stop();
      if (timer !== null) clearTimeout(timer);
    };
  }, [open, onClose, onDetected, stop]);

  const toggleTorch = async (): Promise<void> => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (track === undefined) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn }] } as unknown as MediaTrackConstraints);
      setTorchOn((current) => !current);
    } catch {
      setTorchAvailable(false);
    }
  };

  const submitManual = (): void => {
    const value = manual.trim();
    if (value.length === 0) return;
    onDetected(value);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={title} size="md">
      <div className="space-y-3">
        <div className="relative overflow-hidden rounded-xl bg-slate-950">
          <video
            ref={videoRef}
            muted
            playsInline
            className="aspect-[4/3] w-full object-cover"
          />
          {scanning && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="h-40 w-4/5 rounded-lg border-2 border-brand-400/80 shadow-[0_0_0_9999px_rgba(2,6,23,0.45)]" />
            </div>
          )}
          {!scanning && error === null && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-300">
              در حال روشن‌کردن دوربین…
            </div>
          )}
        </div>

        {error !== null && (
          <p role="alert" className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {torchAvailable && (
            <Button variant="outline" size="sm" onClick={() => void toggleTorch()}>
              {torchOn ? 'خاموش‌کردن نور' : 'روشن‌کردن نور'}
            </Button>
          )}
          {scanning ? (
            <Button variant="outline" size="sm" icon={<CameraOff className="size-4" />} onClick={stop}>
              توقف دوربین
            </Button>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-slate-500">
              <Camera className="size-4" aria-hidden /> دوربین غیرفعال
            </span>
          )}
        </div>

        <div className="space-y-1.5 border-t border-slate-200 pt-3 dark:border-slate-700">
          <label className="flex items-center gap-1 text-xs font-medium text-slate-600 dark:text-slate-300">
            <Keyboard className="size-3.5" aria-hidden /> یا کد را دستی وارد کن
          </label>
          <div className="flex gap-2">
            <Input
              dir="ltr"
              value={manual}
              onChange={(event) => setManual(event.target.value)}
              placeholder="بارکد یا سریال"
              onKeyDown={(event) => {
                if (event.key === 'Enter') submitManual();
              }}
            />
            <Button onClick={submitManual} disabled={manual.trim().length === 0}>
              جستجو
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
