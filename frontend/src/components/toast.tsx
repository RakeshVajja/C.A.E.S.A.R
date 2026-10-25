"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { CircleCheck, CircleAlert, X } from "lucide-react";

/** Toasts (design system §6.5): bottom-right, polite live region, 5 s, dismissible, never take focus. */

interface Toast {
  id: number;
  message: string;
  tone: "success" | "danger";
}

const ToastContext = createContext<(message: string, tone?: Toast["tone"]) => void>(() => undefined);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const show = useCallback(
    (message: string, tone: Toast["tone"] = "success") => {
      const id = ++next.current;
      setToasts((all) => [...all.slice(-2), { id, message, tone }]);
      setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[calc(100%-32px)] max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto flex items-start gap-3 rounded-lg border border-border bg-surface px-4 py-3 shadow-overlay">
            {t.tone === "success" ? (
              <CircleCheck aria-hidden size={20} className="mt-0.5 shrink-0 text-success" />
            ) : (
              <CircleAlert aria-hidden size={20} className="mt-0.5 shrink-0 text-danger" />
            )}
            <p className="flex-1 text-[15px]">{t.message}</p>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
              className="-mr-1 flex size-7 cursor-pointer items-center justify-center rounded text-text-muted hover:text-text"
            >
              <X aria-hidden size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
