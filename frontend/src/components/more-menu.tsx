"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, CircleHelp, Ellipsis, Monitor, Moon, Sun } from "lucide-react";
import { applyTheme, readTheme, type ThemePreference } from "@/lib/theme";

/**
 * The "More" overflow menu in the account area (design system §5): secondary, rarely used items
 * that do not belong in the main navigation — the appearance setting and Help. Change password and
 * Sign out stay visible next to it. Follows the WAI-ARIA menu-button pattern: arrow keys, Home/End,
 * Esc (focus returns to the button), Tab or a click outside closes it. It is positioned inside the
 * viewport: above or below the button, and beside it on the collapsed rail.
 */

const THEMES: { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

const MENU_WIDTH = 224;
const GAP = 8;

export function MoreMenu({ helpHref, compact = false }: { helpHref: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>("system");
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const pathname = usePathname();

  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setPosition(null);
    if (returnFocus) button.current?.focus();
  }, []);

  // Close when the page changes (e.g. after choosing Help).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(false);
  }, [pathname]);

  // Position within the viewport once the menu has its size; then focus the current choice.
  useLayoutEffect(() => {
    if (!open || !button.current || !menu.current) return;
    const r = button.current.getBoundingClientRect();
    const height = menu.current.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = compact ? r.right + GAP : r.right - MENU_WIDTH;
    left = Math.min(Math.max(GAP, left), vw - MENU_WIDTH - GAP);
    let top = compact ? r.bottom - height : r.top - height - GAP;
    if (!compact && top < GAP) top = r.bottom + GAP;
    top = Math.min(Math.max(GAP, top), vh - height - GAP);
    setPosition({ top, left });
    const current = menu.current.querySelector<HTMLElement>('[aria-checked="true"]') ?? items()[0];
    current?.focus();
  }, [open, compact]);

  // A click outside closes the menu (without moving focus).
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) close(false);
    };
    const onResize = () => close(false);
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("resize", onResize);
    };
  }, [open, close]);

  function onMenuKey(e: React.KeyboardEvent) {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const move = (i: number) => list[(i + list.length) % list.length]?.focus();
    if (e.key === "ArrowDown") move(index + 1);
    else if (e.key === "ArrowUp") move(index - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(list.length - 1);
    else if (e.key === "Escape") close(true);
    else if (e.key === "Tab") close(false);
    else return;
    if (e.key !== "Tab") e.preventDefault();
  }

  function choose(value: ThemePreference) {
    applyTheme(value);
    setTheme(value);
    close(true);
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="More options"
        title="More options"
        onClick={() => {
          if (open) close(false);
          else {
            setTheme(readTheme());
            setOpen(true);
          }
        }}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setTheme(readTheme());
            setOpen(true);
          }
        }}
        className={`flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-text-muted transition-colors duration-150 hover:bg-surface-sunken hover:text-text ${open ? "bg-surface-sunken text-text" : ""}`}
      >
        <Ellipsis aria-hidden size={20} strokeWidth={1.75} />
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label="More options"
          onKeyDown={onMenuKey}
          style={{ top: position?.top ?? -9999, left: position?.left ?? -9999, width: MENU_WIDTH }}
          className="fixed z-40 rounded-lg border border-border bg-surface p-1.5 text-text shadow-overlay"
        >
          <div role="group" aria-labelledby={`${menuId}-appearance`}>
            <p id={`${menuId}-appearance`} className="px-2.5 pt-1.5 pb-1 text-[13px] font-medium text-text-muted">
              Appearance
            </p>
            {THEMES.map(({ value, label, Icon }) => (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={theme === value}
                tabIndex={-1}
                onClick={() => choose(value)}
                className="flex min-h-10 w-full cursor-pointer items-center gap-3 rounded-md px-2.5 text-left text-[15px] hover:bg-surface-sunken focus-visible:bg-surface-sunken"
              >
                <Icon aria-hidden size={18} strokeWidth={1.75} className="shrink-0 text-text-muted" />
                <span className="flex-1">{label}</span>
                {theme === value && <Check aria-hidden size={18} strokeWidth={2} className="shrink-0 text-ink" />}
              </button>
            ))}
          </div>
          <div role="separator" className="my-1.5 h-px bg-border" />
          <Link
            href={helpHref}
            role="menuitem"
            tabIndex={-1}
            onClick={() => close(false)}
            className="flex min-h-10 w-full items-center gap-3 rounded-md px-2.5 text-[15px] hover:bg-surface-sunken focus-visible:bg-surface-sunken"
          >
            <CircleHelp aria-hidden size={18} strokeWidth={1.75} className="shrink-0 text-text-muted" />
            Help
          </Link>
        </div>
      )}
    </>
  );
}
