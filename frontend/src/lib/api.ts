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
  if (!response.ok) throw failure(response, body, options);
  return body as T;
}

/** The ApiError for a failed response; an expired session is also reported to the auth listener. */
function failure(response: Response, body: unknown, options: RequestOptions): ApiError {
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
  return apiError;
}

/**
 * Downloads a file from the API (with the session cookie) and hands it to the browser as a save,
 * named by the server's Content-Disposition (or `fallbackName`).
 */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, { credentials: "include", cache: "no-store" });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "The server could not be reached. Check your connection and try again.");
  }
  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Non-JSON answer.
    }
    throw failure(response, body, {});
  }
  const name = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
