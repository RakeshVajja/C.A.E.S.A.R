"use client";

import { Alert, LoadError, Panel, SkeletonRows } from "@/components/ui";
import { api } from "@/lib/api";
import { formatNumber, SOURCE_LABEL } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import type { CredentialState, ProviderCoverage, ProviderStatus, ProviderStatusResponse } from "@/lib/types";

/**
 * Provider configuration and run coverage (Project_plan.md §13.9, §17; decisions #117, #129, #130).
 * A configuration state says only whether credentials are set — never that access works: that is
 * shown only by a successful fetch in a run ("access confirmed").
 */

export const CREDENTIAL_LABEL: Record<CredentialState, string> = {
  NOT_REQUIRED: "No key needed",
  PRESENT: "Credentials set (access not yet confirmed)",
  NOT_CONFIGURED: "Not configured",
  INCOMPLETE: "Incompletely configured",
};

const CREDENTIAL_TONE: Record<CredentialState, string> = {
  NOT_REQUIRED: "text-text",
  PRESENT: "text-text",
  NOT_CONFIGURED: "text-warning",
  INCOMPLETE: "text-danger",
};

export const PROVIDERS_PATH = "/admin/sync/providers";

/** Clarivate's providers: blocked by the backend while the Clarivate gate is closed (§22.6). */
const CLARIVATE: ReadonlySet<ProviderStatus["provider"]> = new Set(["WOS", "JCR"]);

/** The current configuration of the five discovery providers, or of JCR. */
export function ProviderConfigurationPanel({ purpose }: { purpose: ProviderStatus["purpose"] }) {
  const { data, error, reload } = useResource(PROVIDERS_PATH, (signal) => api<ProviderStatusResponse>(PROVIDERS_PATH, { signal }));
  if (error && !data) return <LoadError error={error} onRetry={() => void reload()} />;
  if (!data) return <SkeletonRows rows={3} label="Loading provider configuration" />;
  const rows = data.providers.filter((p) => p.purpose === purpose);
  const blocked = !data.clarivateGate.open;
  return (
    <Panel>
      <div className="overflow-x-auto">
        <table className="data-table">
          <caption className="sr-only">{purpose === "JOURNAL_METRICS" ? "Journal Citation Reports configuration" : "Publication source configuration"}</caption>
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">Configuration</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.provider}>
                <td data-label="Provider" className="font-medium">
                  {p.label}
                </td>
                <td data-label="Configuration">
                  <span className={CREDENTIAL_TONE[p.credentials]}>{CREDENTIAL_LABEL[p.credentials]}</span>
                  {p.issue && <p className="text-[13px] text-text-muted">{p.issue}</p>}
                  {blocked && CLARIVATE.has(p.provider) && (
                    <p className="text-[13px] text-warning">Blocked: no live Clarivate data until provider-data removal (stage 15.8) and Clarivate&apos;s written confirmations are in place.</p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/** Coverage of the five discovery providers in one run (from the snapshot stored at its start). */
export function CoverageTable({ coverage }: { coverage: ProviderCoverage[] | null }) {
  if (!coverage) {
    return <Alert tone="info">This run predates provider coverage reporting.</Alert>;
  }
  return (
    <Panel>
      <div className="overflow-x-auto">
        <table className="data-table">
          <caption className="sr-only">Provider coverage of this run</caption>
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">Configuration at start</th>
              <th scope="col" className="num">
                Identities
              </th>
              <th scope="col">Outcome</th>
              <th scope="col">Coverage</th>
            </tr>
          </thead>
          <tbody>
            {coverage.map((c) => {
              const outcome = [
                c.succeeded && `${formatNumber(c.succeeded)} succeeded`,
                c.failed && `${formatNumber(c.failed)} failed`,
                c.notConfigured && `${formatNumber(c.notConfigured)} not configured`,
                c.blockedTasks && `${formatNumber(c.blockedTasks)} blocked by Clarivate policy`,
                c.unfinished && `${formatNumber(c.unfinished)} unfinished`,
              ].filter(Boolean);
              return (
                <tr key={c.provider}>
                  <td data-label="Provider" className="font-medium">
                    {SOURCE_LABEL[c.provider]}
                  </td>
                  <td data-label="Configuration at start">
                    {c.blocked ? (
                      <>
                        <span className="text-warning">Blocked by Clarivate policy</span>
                        <p className="text-[13px] text-text-muted">Credentials were set; no live Clarivate data until stage 15.8 and the written confirmations.</p>
                      </>
                    ) : (
                      <span className={CREDENTIAL_TONE[c.credentials]}>{CREDENTIAL_LABEL[c.credentials]}</span>
                    )}
                  </td>
                  <td data-label="Identities" className="num">
                    {formatNumber(c.identities)}
                  </td>
                  <td data-label="Outcome" className="text-[13px]">
                    {outcome.length > 0 ? outcome.join(" · ") : "–"}
                    {c.credentials === "PRESENT" && !c.blocked && (
                      <p className={c.accessConfirmed ? "text-success" : "text-warning"}>{c.accessConfirmed ? "Access confirmed" : "Access not confirmed in this run"}</p>
                    )}
                  </td>
                  <td data-label="Coverage">
                    <span className={c.complete ? "text-success" : "text-warning"}>{c.complete ? "Complete" : "Incomplete"}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
