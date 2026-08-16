import React, { useEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { X, Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * Shared modal shell.
 *
 * Three things it guarantees that the previous per-modal markup did not:
 *
 * 1. It renders through a portal to <body>. Modals used to live inside the
 *    animated page wrapper, and an ancestor with a transform/opacity creates
 *    a stacking context — so a high z-index inside it still painted *below*
 *    the sidebar. Portalling removes the ancestor entirely.
 * 2. The backdrop is `fixed inset-0` at 85% black, covering the full viewport
 *    including the sidebar and bottom nav. Nothing bleeds through.
 * 3. The panel is capped at 90dvh with a scrolling body and a pinned footer,
 *    so long content scrolls instead of clipping and the primary action is
 *    always reachable.
 */

type ModalSize = 'sm' | 'md' | 'lg';

const SIZES: Record<ModalSize, string> = {
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-md',
  lg: 'sm:max-w-lg',
};

interface ModalProps {
  onClose: () => void;
  children: React.ReactNode;
  size?: ModalSize;
  /** Labels the dialog for screen readers; pair with <ModalHeader title>. */
  labelledBy?: string;
  /** Nested modals (a picker opened from inside a modal) sit one tier up. */
  nested?: boolean;
  /** Mobile presentation: a bottom sheet, or a centred card. */
  variant?: 'sheet' | 'center';
  className?: string;
}

export function Modal({
  onClose,
  children,
  size = 'md',
  labelledBy,
  nested = false,
  variant = 'sheet',
  className,
}: ModalProps) {
  // Escape closes; body scroll is locked while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);

    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const zBackdrop = nested ? 'var(--z-nested-backdrop)' : 'var(--z-backdrop)';
  const zPanel = nested ? 'var(--z-nested-modal)' : 'var(--z-modal)';

  return createPortal(
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.12 }}
        onClick={onClose}
        style={{ zIndex: zBackdrop }}
        className="modal-backdrop"
      />

      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        initial={{ opacity: 0, y: variant === 'sheet' ? 24 : 0, scale: variant === 'center' ? 0.98 : 1 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: variant === 'sheet' ? 24 : 0, scale: variant === 'center' ? 0.98 : 1 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        style={{ zIndex: zPanel }}
        className={cn(
          'modal-panel w-full',
          variant === 'sheet'
            ? // Bottom sheet on mobile, centred card from 640px up.
              'inset-x-0 bottom-0 rounded-t-3xl sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-3xl'
            : 'left-1/2 top-1/2 w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-3xl',
          SIZES[size],
          className
        )}
      >
        {children}
      </motion.div>
    </>,
    document.body
  );
}

export function ModalHeader({
  title,
  subtitle,
  onClose,
  id,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose?: () => void;
  id?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-start gap-3 border-b border-line px-5 py-4 sm:px-6">
      <div className="min-w-0 flex-1">
        <h2 id={id} className="truncate text-lg font-bold text-fg">
          {title}
        </h2>
        {subtitle && <p className="mt-0.5 truncate text-sm text-muted">{subtitle}</p>}
      </div>
      {children}
      {onClose && (
        <button
          onClick={onClose}
          aria-label="Close"
          className="tap -mr-2 shrink-0 rounded-full text-muted transition-colors duration-100 hover:text-fg"
        >
          <X size={20} />
        </button>
      )}
    </div>
  );
}

export function ModalBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn('modal-body px-5 py-4 sm:px-6', className)}>{children}</div>;
}

export function ModalFooter({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'modal-footer px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6',
        className
      )}
    >
      {children}
    </div>
  );
}

interface ConfirmDialogProps {
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  icon?: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Standard confirm step for irreversible actions. */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  icon,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();

  return (
    <Modal onClose={onCancel} size="sm" variant="center" labelledBy={titleId}>
      <div className="p-6 text-center">
        {icon && (
          <div
            className={cn(
              'mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border',
              destructive
                ? 'border-danger/30 bg-danger/10 text-danger'
                : 'border-accent/30 bg-accent/10 text-accent'
            )}
          >
            {icon}
          </div>
        )}
        <h2 id={titleId} className="text-lg font-bold text-fg">
          {title}
        </h2>
        {description && (
          <p className="mt-2 text-sm leading-relaxed text-muted">{description}</p>
        )}

        <div className="mt-6 flex flex-col gap-2.5">
          <button
            onClick={onConfirm}
            disabled={busy}
            className={cn(
              'flex w-full items-center justify-center gap-2 py-3 text-sm',
              destructive ? 'btn-danger' : 'btn-primary'
            )}
          >
            {busy && <Loader2 size={16} className="animate-spin" />}
            {confirmLabel}
          </button>
          <button onClick={onCancel} disabled={busy} className="btn-secondary w-full py-3 text-sm">
            {cancelLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
