"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Loads data for a screen. `key` identifies the request (e.g. path + query); a new key reloads and
 * an outdated response is ignored. `reload()` refreshes without clearing the current data.
 */
export function useResource<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(key !== null);
  const loader = useRef(load);
  const latest = useRef(0);

  useEffect(() => {
    loader.current = load;
  });

  const run = useCallback(async (clear: boolean) => {
    const request = ++latest.current;
    const controller = new AbortController();
    if (clear) setData(null);
    setLoading(true);
    setError(null);
    try {
      const result = await loader.current(controller.signal);
      if (request === latest.current) setData(result);
    } catch (e) {
      if ((e as Error)?.name !== "AbortError" && request === latest.current) setError(e);
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (key === null) return;
    // Loading starts when the key changes; state is set when the request settles.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void run(true);
  }, [key, run]);

  const reload = useCallback(() => run(false), [run]);
  return { data, error, loading, reload, setData };
}
