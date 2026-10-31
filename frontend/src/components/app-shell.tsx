"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  BookOpen,
  ChartColumn,
  FilePlus2,
  Gauge,
  GitMerge,
  KeyRound,
  LayoutDashboard,
  Library,
  ListChecks,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { homeFor, useAuth } from "@/lib/auth";
import type { OwnList, Role } from "@/lib/types";
import { MoreMenu } from "./more-menu";
import { Alert, Button, Skeleton } from "./ui";

/**
 * Application shell (design system §4–§5): a 240px sidebar from 1024px that can be collapsed to a
 * 64px icon rail (remembered in this browser), a top bar with a disclosure menu below. Navigation
 * is derived from the server-provided role.
 */

const COLLAPSED_KEY = "cse-hub:sidebar-collapsed";

interface NavItem {
  href: string;
  label: string;
  Icon: typeof BookOpen;
  badge?: "pending" | "candidates";
}

const NAV: Record<Role, NavItem[]> = {
  PROFESSOR: [
    { href: "/professor", label: "Dashboard", Icon: LayoutDashboard },
    { href: "/professor/pending", label: "Pending", Icon: ListChecks, badge: "pending" },
    { href: "/professor/publications", label: "My publications", Icon: BookOpen },
    { href: "/professor/add", label: "Add publication", Icon: FilePlus2 },
    { href: "/professor/profile", label: "Profile", Icon: UserRound },
  ],
  ADMIN: [
    { href: "/admin", label: "Dashboard", Icon: LayoutDashboard },
    { href: "/admin/professors", label: "Professors", Icon: Users },
    { href: "/admin/publications", label: "Publications", Icon: Library },
    { href: "/admin/duplicates", label: "Duplicates", Icon: GitMerge, badge: "candidates" },
    { href: "/admin/sync", label: "Synchronization", Icon: RefreshCw },
    { href: "/admin/journal-metrics", label: "Journal metrics", Icon: Gauge },
    { href: "/admin/analytics", label: "Analytics", Icon: ChartColumn },
  ],
};

function isActive(pathname: string, href: string) {
  return href === "/professor" || href === "/admin" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

/** Pending-verification or open-candidate count for the navigation badge. */
function useBadge(role: Role, pathname: string) {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    const load =
      role === "PROFESSOR"
        ? api<OwnList>("/me/publications?status=PENDING&limit=1").then((r) => r.counts.PENDING)
        : api<{ total: number }>("/admin/duplicate-candidates?status=OPEN&limit=1").then((r) => r.total);
    load.then(
      (n) => active && setCount(n),
      () => active && setCount(null),
    );
    return () => {
      active = false;
    };
  }, [role, pathname]);
  return count;
}

function NavList({ role, pathname, onNavigate, collapsed = false }: { role: Role; pathname: string; onNavigate?: () => void; collapsed?: boolean }) {
  const badge = useBadge(role, pathname);
  return (
    <ul className="flex flex-col gap-0.5">
      {NAV[role].map(({ href, label, Icon, badge: badgeKind }) => {
        const active = isActive(pathname, href);
        const count = badgeKind ? badge : null;
        return (
          <li key={href}>
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              aria-label={count ? `${label}, ${count} ${count === 1 ? "item" : "items"}` : collapsed ? label : undefined}
              title={collapsed ? (count ? `${label} (${count})` : label) : undefined}
              className={`relative flex min-h-10 items-center gap-3 rounded-md text-[15px] transition-colors duration-150 ${collapsed ? "justify-center px-0" : "px-3"} ${
                active ? "bg-ink-subtle font-medium text-ink" : "text-text hover:bg-surface-sunken"
              }`}
            >
              <Icon aria-hidden size={20} strokeWidth={1.75} className="shrink-0" />
              {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
              {/* Counts are quiet: plain tabular figures, or a small dot on the collapsed rail. */}
              {count && !collapsed ? <span className={`text-[13px] tabular-nums ${active ? "text-ink" : "text-text-muted"}`}>{count}</span> : null}
              {count && collapsed ? <span aria-hidden className="absolute top-2 right-2.5 size-1.5 rounded-full bg-info" /> : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function Wordmark() {
  return (
    <div>
      <p className="text-lg leading-6 font-semibold">CSE Research Hub</p>
    </div>
  );
}

function AccountBlock({ collapsed = false }: { collapsed?: boolean }) {
  const { user, signOut } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (!user) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      {collapsed ? (
        <div className="flex justify-center">
          <MoreMenu helpHref={`${homeFor(user.role)}/help`} compact />
        </div>
      ) : (
        <div className="flex items-start gap-2 pl-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-medium">{user.professor?.name ?? "Administrator"}</p>
            <p className="truncate text-[13px] text-text-muted">{user.email}</p>
          </div>
          <MoreMenu helpHref={`${homeFor(user.role)}/help`} />
        </div>
      )}
      <Link
        href="/change-password"
        aria-label={collapsed ? "Change password" : undefined}
        title={collapsed ? "Change password" : undefined}
        className={`flex min-h-10 items-center gap-3 rounded-md text-[15px] hover:bg-surface-sunken ${collapsed ? "justify-center" : "px-3"}`}
      >
        <KeyRound aria-hidden size={20} strokeWidth={1.75} />
        {!collapsed && "Change password"}
      </Link>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await signOut();
          router.replace("/login");
        }}
        aria-label={collapsed ? "Sign out" : undefined}
        title={collapsed ? "Sign out" : undefined}
        className={`flex min-h-10 cursor-pointer items-center gap-3 rounded-md text-left text-[15px] hover:bg-surface-sunken disabled:opacity-50 ${collapsed ? "justify-center" : "px-3"}`}
      >
        <LogOut aria-hidden size={20} strokeWidth={1.75} />
        {!collapsed && "Sign out"}
      </button>
    </div>
  );
}

export function AppShell({ role, children }: { role: Role; children: React.ReactNode }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  // The choice is a per-browser convenience; storage may be unavailable (private mode).
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCollapsed(localStorage.getItem(COLLAPSED_KEY) === "1");
    } catch {
      // keep the default (expanded)
    }
  }, []);
  const toggleSidebar = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, c ? "0" : "1");
      } catch {
        // not remembered; still toggles
      }
      return !c;
    });
  };

  return (
    <div className={`min-h-dvh ${collapsed ? "lg:pl-16" : "lg:pl-60"}`}>
      <a href="#main" className="sr-only z-[70] rounded-md bg-ink px-4 py-2 text-on-ink focus:not-sr-only focus:fixed focus:top-3 focus:left-3">
        Skip to main content
      </a>

      {/* ≥ 1024px: fixed sidebar */}
      <aside
        id="sidebar"
        className={`fixed inset-y-0 left-0 z-20 hidden flex-col gap-6 border-r border-border bg-surface py-5 lg:flex ${collapsed ? "w-16 px-2" : "w-60 px-3"}`}
      >
        <div className={`flex items-center gap-2 ${collapsed ? "justify-center" : "justify-between pl-3"}`}>
          {!collapsed && <Wordmark />}
          <button
            type="button"
            onClick={toggleSidebar}
            aria-expanded={!collapsed}
            aria-controls="sidebar"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-text-muted transition-colors duration-150 hover:bg-surface-sunken hover:text-text"
          >
            {collapsed ? <PanelLeftOpen aria-hidden size={20} strokeWidth={1.75} /> : <PanelLeftClose aria-hidden size={20} strokeWidth={1.75} />}
          </button>
        </div>
        <nav aria-label="Main" className="flex-1 overflow-y-auto">
          <NavList role={role} pathname={pathname} collapsed={collapsed} />
        </nav>
        <AccountBlock collapsed={collapsed} />
      </aside>

      {/* < 1024px: top bar with a disclosure menu */}
      <header className="sticky top-0 z-20 border-b border-border bg-surface lg:hidden">
        <div className="flex min-h-14 items-center justify-between px-4">
          <Wordmark />
          <Button
            variant="primary"
            compact
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            onClick={() => setMenuOpen((o) => !o)}
            icon={menuOpen ? <X aria-hidden size={18} /> : <Menu aria-hidden size={18} />}
          >
            Menu
          </Button>
        </div>
        {menuOpen && (
          <div id="mobile-menu" className="flex max-h-[calc(100dvh-56px)] flex-col gap-4 overflow-y-auto border-t border-border px-3 pt-3 pb-4">
            <nav aria-label="Main">
              <NavList role={role} pathname={pathname} onNavigate={() => setMenuOpen(false)} />
            </nav>
            <AccountBlock />
          </div>
        )}
      </header>

      <main id="main" className="mx-auto w-full max-w-[1200px] px-4 pt-6 pb-16 md:px-8 md:pt-8">
        {children}
      </main>
    </div>
  );
}

/**
 * Protects a role's screens: waits for the session, sends signed-out users to sign-in,
 * temporary-password accounts to the change-password screen, and the other role home.
 */
export function RoleGate({ role, children }: { role: Role; children: React.ReactNode }) {
  const { status, user, refresh } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  const redirect =
    status === "signedOut"
      ? `/login?next=${encodeURIComponent(pathname)}`
      : status === "signedIn" && user
        ? user.mustChangePassword
          ? "/change-password"
          : user.role !== role
            ? homeFor(user.role)
            : null
        : null;

  useEffect(() => {
    if (redirect) router.replace(redirect);
  }, [redirect, router]);

  if (status === "unavailable") {
    return (
      <div className="mx-auto max-w-lg px-4 pt-16">
        <Alert
          tone="danger"
          role="alert"
          title="The server could not be reached"
          action={
            <Button compact onClick={() => void refresh()}>
              Try again
            </Button>
          }
        >
          Check that the backend is running, then try again.
        </Alert>
      </div>
    );
  }
  if (status !== "signedIn" || redirect) {
    return (
      <div role="status" aria-label="Checking your session" className="flex min-h-dvh lg:pl-60">
        <div className="mx-auto w-full max-w-[1200px] px-4 pt-8 md:px-8">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="mt-6 h-40 w-full" />
        </div>
      </div>
    );
  }
  return <AppShell role={role}>{children}</AppShell>;
}
