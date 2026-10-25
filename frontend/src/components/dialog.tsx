"use client";

import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { Button } from "./ui";

/**
 * Native <dialog> (design system §6.5): modal focus handling and Esc come from the browser;
 * focus returns to the trigger on close. The scrim has no blur.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  busy,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** While an action runs, Esc and the close button do nothing. */
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      className="m-auto w-[calc(100%-32px)] max-w-[520px] rounded-lg border border-border bg-surface p-0 text-text shadow-overlay backdrop:bg-[var(--scrim)]"
    >
      {open && (
        <div className="flex flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <h2 id={titleId} className="text-xl leading-7 font-semibold">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              aria-label="Close"
              className="-mr-2 flex size-9 cursor-pointer items-center justify-center rounded-md text-text-muted hover:bg-surface-sunken hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
            >
              <X aria-hidden size={20} />
            </button>
          </div>
          <div className="px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-4">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

/** A confirmation dialog for one action. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  busyLabel,
  danger,
  busy,
  onConfirm,
  onClose,
  error,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  error?: string | null;
}) {
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} loading={busy} loadingLabel={busyLabel}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {children}
        {error && (
          <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-[15px] text-text">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
