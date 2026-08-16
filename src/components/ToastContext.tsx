import React, { createContext, useContext, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { cn } from '../lib/utils';

type ToastType = 'success' | 'error' | 'info';

interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastContextType {
  toast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((message: string, type: ToastType = 'success') => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {/* Toasts sit above every modal so confirmations stay visible. */}
      <div
        style={{ zIndex: 'var(--z-toast)' }}
        className="fixed top-6 left-1/2 -translate-x-1/2 flex flex-col gap-3 w-full max-w-[320px] pointer-events-none px-6"
      >
        <AnimatePresence mode="popLayout">
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: -20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
              className="pointer-events-auto"
            >
              <div className={cn(
                "flex items-start gap-3 p-4 rounded-2xl border shadow-2xl",
                t.type === 'success' && "bg-green-500/10 border-green-500/20 text-green-400",
                t.type === 'error' && "bg-danger/10 border-danger/20 text-danger",
                t.type === 'info' && "bg-accent/10 border-accent/20 text-accent"
              )}>
                <div className="shrink-0 mt-0.5">
                  {t.type === 'success' && <CheckCircle2 size={16} />}
                  {t.type === 'error' && <AlertCircle size={16} />}
                  {t.type === 'info' && <Info size={16} />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-black uppercase tracking-wider leading-tight">
                    {t.message}
                  </p>
                </div>
                <button 
                  onClick={() => removeToast(t.id)}
                  className="shrink-0 p-1 hover:bg-surface-2 rounded-full transition-colors"
                >
                  <X size={14} />
                </button>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
