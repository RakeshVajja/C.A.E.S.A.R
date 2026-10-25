"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, ApiError, onAuthError } from "./api";
import type { Role, User } from "./types";

/**
 * Session state from GET /api/auth/me (the HttpOnly cookie is never readable here). Role and
 * forced-password-change state always come from the server.
 */

type Status = "loading" | "signedOut" | "signedIn" | "unavailable";

interface AuthValue {
  status: Status;
  user: User | null;
  /** Re-reads the session (after sign-in, password change, or an auth error). */
  refresh: () => Promise<User | null>;
  setUser: (user: User | null) => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function homeFor(role: Role): string {
  return role === "ADMIN" ? "/admin" : "/professor";
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUserState] = useState<User | null>(null);

  const setUser = useCallback((next: User | null) => {
    setUserState(next);
    setStatus(next ? "signedIn" : "signedOut");
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { user: me } = await api<{ user: User }>("/auth/me", { ignoreAuthErrors: true });
      setUser(me);
      return me;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setUser(null);
        return null;
      }
      // The backend is unreachable: keep the screen honest instead of pretending to be signed out.
      setUserState(null);
      setStatus("unavailable");
      return null;
    }
  }, [setUser]);

  useEffect(() => {
    // Initial session check; state is set when the request settles.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  useEffect(() => {
    onAuthError((error) => {
      if (error.status === 401) setUser(null);
      else void refresh(); // PASSWORD_CHANGE_REQUIRED: the guard then shows the change-password screen
    });
    return () => onAuthError(null);
  }, [refresh, setUser]);

  const signOut = useCallback(async () => {
    try {
      await api("/auth/logout", { method: "POST", ignoreAuthErrors: true });
    } finally {
      setUser(null);
    }
  }, [setUser]);

  const value = useMemo(() => ({ status, user, refresh, setUser, signOut }), [status, user, refresh, setUser, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}
