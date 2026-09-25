"use client";

import { useCallback, useEffect, useState } from "react";
import { apiBaseUrl } from "@/lib/config";

type Status =
  | { state: "checking" }
  | { state: "ok"; latencyMs: number }
  | { state: "error"; message: string };

async function fetchStatus(): Promise<Status> {
  try {
    const res = await fetch(`${apiBaseUrl}/health`, { cache: "no-store" });
    const body = await res.json();
    if (res.ok && body.status === "ok") {
      return { state: "ok", latencyMs: body.database.latencyMs };
    }
    return { state: "error", message: `Backend reported HTTP ${res.status}` };
  } catch {
    return { state: "error", message: "Backend unreachable" };
  }
}

export default function BackendStatus() {
  const [status, setStatus] = useState<Status>({ state: "checking" });

  useEffect(() => {
    let active = true;
    fetchStatus().then((result) => {
      if (active) setStatus(result);
    });
    return () => {
      active = false;
    };
  }, []);

  const check = useCallback(async () => {
    setStatus({ state: "checking" });
    setStatus(await fetchStatus());
  }, []);

  return (
    <div className="flex items-center gap-3 text-sm">
      <span
        className={`h-2.5 w-2.5 rounded-full ${
          status.state === "ok" ? "bg-emerald-500" : status.state === "error" ? "bg-rose-500" : "bg-amber-400"
        }`}
      />
      <span>
        {status.state === "checking" && "Checking backend…"}
        {status.state === "ok" && `Backend and database reachable (${status.latencyMs} ms)`}
        {status.state === "error" && status.message}
      </span>
      <button
        onClick={check}
        disabled={status.state === "checking"}
        className="rounded border border-current/20 px-2 py-0.5 text-xs disabled:opacity-50"
      >
        Recheck
      </button>
    </div>
  );
}
