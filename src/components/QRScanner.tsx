import React, { useEffect, useRef, useState } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { motion, AnimatePresence } from 'motion/react';
import { X, Camera, Zap, RefreshCw, AlertCircle, Loader2, Image as ImageIcon } from 'lucide-react';

interface QRScannerProps {
  onScan: (data: string) => void;
  onClose: () => void;
}

export function QRScanner({ onScan, onClose }: QRScannerProps) {
  const [error, setError] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const startScanner = async () => {
      try {
        const scanner = new Html5Qrcode("qr-reader");
        scannerRef.current = scanner;

        const config = { 
          fps: 10, 
          qrbox: { width: 200, height: 200 },
          aspectRatio: 1.0
        };

        // Attempt to start with back camera by default
        await scanner.start(
          { facingMode: "environment" },
          config,
          (decodedText) => {
            scanner.stop().then(() => {
              onScan(decodedText);
            }).catch(err => {
              console.error('Error stopping scanner:', err);
              onScan(decodedText);
            });
          },
          (errorMessage) => {
            // Ignore common scan failures
          }
        );
        setIsInitializing(false);
      } catch (err: any) {
        console.error('Failed to start scanner:', err);
        let errorMessage = err.message || 'Could not access camera';
        
        if (errorMessage.includes('NotAllowedError') || errorMessage.includes('Permission denied')) {
          errorMessage = 'Camera access denied. Please allow camera access in your browser settings or try opening the app in a new tab.';
        } else if (errorMessage.includes('NotFoundError')) {
          errorMessage = 'No camera found on this device.';
        }
        
        setError(errorMessage);
        setIsInitializing(false);
      }
    };

    startScanner();

    return () => {
      if (scannerRef.current) {
        if (scannerRef.current.isScanning) {
          scannerRef.current.stop()
            .then(() => {
              // Properly stopped
            })
            .catch(err => {
              // Ignore DOM removal errors during unmount
              if (err?.message?.includes('removeChild') || err?.message?.includes('Node')) return;
              console.warn('Scanner stop warning:', err);
            });
        }
      }
    };
  }, [onScan]);

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!scannerRef.current) {
      scannerRef.current = new Html5Qrcode("qr-reader");
    }

    // If camera is scanning, stop it first
    if (scannerRef.current.isScanning) {
      try {
        await scannerRef.current.stop();
      } catch (err) {
        console.error('Failed to stop camera scanner:', err);
      }
    }

    setIsProcessingImage(true);
    setError(null);

    try {
      const result = await scannerRef.current.scanFileV2(file, false);
      onScan(result.decodedText);
    } catch (err: any) {
      console.error('Failed to scan image:', err);
      setError('Could not find QR code in image. Please try another image or use camera.');
      // Restart camera if it was running or just let user decide? 
      // Better to just let user decide or provide a "Retry Camera" button in error state.
    } finally {
      setIsProcessingImage(false);
      // Reset input
      if (e.target) e.target.value = '';
    }
  };

  return (
    <div style={{ zIndex: "var(--z-backdrop)" }} className="fixed inset-0 flex items-center justify-center p-6">
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-black/85"
      />
      
      <motion.div
        initial={{ scale: 0.9, opacity: 0, y: 10 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.9, opacity: 0, y: 10 }}
        className="w-full max-w-[260px] glass border border-line rounded-3xl p-4 shadow-2xl relative overflow-hidden"
      >
        <div className="flex items-center justify-between mb-3 px-1">
          <div className="flex flex-col">
            <h2 className="text-xs font-black uppercase tracking-tight text-white">Scanner</h2>
            <p className="text-sm font-medium text-muted">Add someone</p>
          </div>
          <button 
            onClick={onClose}
            className="w-6 h-6 rounded-full bg-surface-2 border border-line flex items-center justify-center text-muted hover:text-fg transition-colors"
          >
            <X size={12} />
          </button>
        </div>

        <div className="relative aspect-square w-full bg-[#08080a] rounded-2xl overflow-hidden border border-line flex items-center justify-center shadow-inner">
          <div id="qr-reader" className="w-full h-full" />
          
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <div className="w-[180px] h-[180px] border-2 border-line rounded-3xl relative">
              <div className="absolute -top-1 -left-1 w-4 h-4 border-t-2 border-l-2 border-accent rounded-tl-lg" />
              <div className="absolute -top-1 -right-1 w-4 h-4 border-t-2 border-r-2 border-accent rounded-tr-lg" />
              <div className="absolute -bottom-1 -left-1 w-4 h-4 border-b-2 border-l-2 border-accent rounded-bl-lg" />
              <div className="absolute -bottom-1 -right-1 w-4 h-4 border-b-2 border-r-2 border-accent rounded-br-lg" />
            </div>
          </div>
          
          {isInitializing && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black">
              <Loader2 size={20} className="text-accent animate-spin" />
              <p className="text-xs font-black uppercase tracking-widest text-subtle">Waking sensor...</p>
            </div>
          )}

          {error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-4 text-center bg-black/90 z-20">
              <AlertCircle size={24} className="text-danger mb-2" />
              <p className="text-xs font-black uppercase tracking-widest text-danger mb-1">Access Denied</p>
              <div className="max-h-[100px] overflow-y-auto px-2 mb-4">
                <p className="text-xs text-muted leading-relaxed uppercase tracking-wider">{error}</p>
              </div>
              <div className="flex flex-col gap-2 w-full max-w-[160px]">
                <button 
                  onClick={() => {
                    setError(null);
                    setIsInitializing(true);
                    // The useEffect will trigger again because of dependency or we call it
                    window.location.reload(); 
                  }}
                  className="w-full py-2 rounded-xl bg-accent text-white text-xs font-black uppercase tracking-widest shadow-lg active:scale-95 transition-colors"
                >
                  Grant Permission
                </button>
                <button 
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full py-2 rounded-xl bg-surface-2 border border-line text-muted text-xs font-black uppercase tracking-widest active:scale-95 transition-colors"
                >
                  Import QR Image
                </button>
              </div>
            </div>
          )}

          {isProcessingImage && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60">
              <Loader2 size={20} className="text-accent animate-spin" />
              <p className="text-xs font-black uppercase tracking-widest text-muted">Reading Image...</p>
            </div>
          )}
          
          {!error && !isInitializing && (
            <div className="absolute inset-0 pointer-events-none border-[20px] border-black/40">
              <motion.div 
                animate={{ top: ['0%', '100%', '0%'] }}
                transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}
                className="absolute left-0 right-0 h-0.5 bg-accent/50"
              />
            </div>
          )}
        </div>

        <div className="mt-4 flex flex-col items-center gap-3 text-center">
          <p className="text-sm text-muted leading-relaxed max-w-[150px]">
            Align QR or import image.
          </p>
          <div className="flex items-center gap-2">
             <button 
              onClick={() => {
                // If scanner stopping or something, it might be tricky.
                // But generally html5-qrcode handles it.
                window.location.reload();
              }}
              className="p-2 rounded-lg bg-surface-2 border border-line text-accent hover:text-accent transition-colors"
              title="Reset Camera"
             >
               <Camera size={12} />
             </button>
             <button 
              onClick={() => fileInputRef.current?.click()}
              className="p-2 rounded-lg bg-surface-2 border border-line text-accent hover:text-accent transition-colors"
              title="Import Image"
             >
               <ImageIcon size={12} />
             </button>
             <div className="p-2 rounded-lg bg-surface-2 border border-line text-yellow-400/40">
               <Zap size={12} />
             </div>
          </div>
          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleImageUpload} 
            accept="image/*" 
            className="hidden" 
          />
        </div>
      </motion.div>

      <style>{`
        #qr-reader video {
          width: 100% !important;
          height: 100% !important;
          object-fit: cover !important;
        }
      `}</style>
    </div>
  );
}
