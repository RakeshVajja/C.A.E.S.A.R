import { apiBaseUrl } from "./config";

/**
 * Browser-side API client. Every request carries the HttpOnly session cookie
 * (`credentials: 'include'`); the browser adds the Origin header the backend checks.
 * Errors arrive in the backend's single shape { error: { code, message, details? } }.
 */

export interface FieldIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Field-level validation issues (`details[]` with `path`), if any. */
  get fieldIssues(): FieldIssue[] {
    return Array.isArray(this.details) ? this.details.filter((d): d is FieldIssue => typeof d?.path === "string" && typeof d?.message === "string") : [];
  }
}

type Listener = (error: ApiError) => void;
let authListener: Listener | null = null;

/** The auth provider listens for 401 / forced-password-change answers from any request. */
export function onAuthError(listener: Listener | null) {
  authListener = listener;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** For the sign-in request itself: a 401 is a normal answer, not an expired session. */
  ignoreAuthErrors?: boolean;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      method: options.method ?? "GET",
      credentials: "include",
      cache: "no-store",
      headers: options.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error;
    throw new ApiError(0, "NETWORK_ERROR", "The server could not be reached. Check your connection and try again.");
  }

  if (response.status === 204) return undefined as T;
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON answer (e.g. a proxy error page).
  }
  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    const apiError = new ApiError(
      response.status,
      error?.code ?? "UNEXPECTED_RESPONSE",
      error?.message ?? `The server answered with HTTP ${response.status}.`,
      error?.details,
    );
    if (!options.ignoreAuthErrors && (apiError.status === 401 || apiError.code === "PASSWORD_CHANGE_REQUIRED")) {
      authListener?.(apiError);
    }
    throw apiError;
  }
  return body as T;
}

/** Builds a query string, dropping empty values. */
export function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

/** A message fit for display; unknown errors never leak internals. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "Something went wrong. Try again.";
}
