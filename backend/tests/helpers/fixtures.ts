import fs from 'fs';
import path from 'path';

/** A recorded HTTP response (see scripts/record-openalex-fixtures.ts). */
export interface RecordedResponse {
  request: string;
  status: number;
  contentType: string;
  body: unknown;
}

export function loadFixture(source: string, name: string): RecordedResponse {
  const file = path.resolve(__dirname, '../fixtures', source, `${name}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as RecordedResponse;
}

export function toResponse(recorded: Pick<RecordedResponse, 'status' | 'contentType' | 'body'>, headers: Record<string, string> = {}): Response {
  const text = typeof recorded.body === 'string' ? recorded.body : JSON.stringify(recorded.body);
  return new Response(text, { status: recorded.status, headers: { 'content-type': recorded.contentType, ...headers } });
}

export type Route = RecordedResponse | (() => Response | Promise<Response>);

/**
 * A fetch replacement that replays recorded responses by exact request URL.
 * `overrides` take precedence (keyed by URL) and may be functions for failure injection.
 * Unknown URLs fail loudly so a changed request shape is noticed.
 */
export function replayFetch(recorded: RecordedResponse[], overrides: Record<string, Route> = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const routes = new Map<string, Route>(recorded.map((r) => [r.request, r]));
  for (const [url, route] of Object.entries(overrides)) routes.set(url, route);

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const route = routes.get(url);
    if (!route) throw new Error(`No recorded response for ${url}`);
    return typeof route === 'function' ? route() : toResponse(route);
  }) as typeof fetch;

  return { fetchImpl, calls };
}

export const noSleep = async () => {};
