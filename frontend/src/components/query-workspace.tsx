"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileDown, LoaderCircle, RotateCcw, Wand2 } from "lucide-react";
import { CuratedChip, SourceChips, StatusChip } from "./chips";
import { useToast } from "./toast";
import { Alert, Button, Doi, EmptyState, ExternalProfileLink, LoadError, Pagination, Panel, SkeletonRows } from "./ui";
import { api, ApiError, downloadFile, errorMessage } from "@/lib/api";
import { formatDate, formatNumber, plural, TYPE_LABEL } from "@/lib/format";
import {
  ApiGroup,
  ApiLinkScope,
  AppliedQuery,
  BuilderGroup,
  builderKey,
  builderOf,
  citationDisplay,
  decodeQuery,
  emptyRoot,
  encodeQuery,
  fitsInUrl,
  fromApiTree,
  LinkDraft,
  linkDraftOf,
  linkToApi,
  mapServerIssues,
  PresetMeta,
  QueryFieldsResponse,
  QueryRow,
  sameFilter,
  SearchResponse,
  SORT_LABEL,
  SortKey,
  toApiTree,
} from "@/lib/query-builder";
import type { Source, TypeFamily } from "@/lib/types";

/**
 * The query workspace shared by the professor's Query publications page and the administrator's
 * Analytics page (Project_plan.md §24.7–§24.8; decisions #154–#159, stages Q2–Q3).
 *
 * The applied query lives in the URL (D11): Apply validates locally, runs the query and then
 * writes the URL; reload, bookmarks and back / forward restore the builder from the URL and run
 * it again through the server; a malformed or refused URL shows an error and resets the builder.
 * The server validates and authorizes every request; nothing here widens a scope.
 *
 * Consistency rules:
 *  - The rows on screen always belong to the applied query. When the applied query is replaced,
 *    cleared or refused, its rows disappear at once. Only sorting and paging of the same query
 *    keep the previous rows on screen while the next page loads, visibly marked as updating.
 *  - Builder edits are a draft until Apply. While the draft differs from the applied query an
 *    "Unsaved filter changes" note offers Apply and Discard, and sorting and paging are paused, so
 *    they never discard edits silently or show rows for a query the builder no longer describes.
 */

const SEARCH_ERRORS_FROM_LINK = [400, 404, 409];

type Notice = { tone: "danger" | "warning" | "info"; title: string; text: string } | null;

/** A server message as a sentence (the API's messages have no final full stop). */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

export interface WorkspaceOptions {
  /** API base, e.g. "/me/publication-queries". */
  base: string;
  meta: QueryFieldsResponse;
  reloadMeta: () => void;
  /** The administrator's page: link scope, defaults (D3), and "no query" = department view. */
  admin: boolean;
}

export function useQueryWorkspace({ base, meta, reloadMeta, admin }: WorkspaceOptions) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const urlKey = params.toString();
  const pageDefault = meta.limits.pageDefault;
  const maxProfessors = meta.link?.maxProfessors ?? 50;
  const defaultQuery = meta.defaultQuery;

  const initialBuilder = useCallback(
    () => (admin && defaultQuery ? builderOf(defaultQuery) : { root: emptyRoot(), link: null }),
    [admin, defaultQuery],
  );
  const [root, setRoot] = useState<BuilderGroup>(() => initialBuilder().root);
  const [link, setLink] = useState<LinkDraft | null>(() => initialBuilder().link);
  const [issues, setIssues] = useState<Map<string, string>>(new Map());
  const [linkIssue, setLinkIssue] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [result, setResult] = useState<SearchResponse | null>(null);
  /** The rows on screen are the previous page / sort of the same query while the next one loads. */
  const [stale, setStale] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [running, setRunning] = useState(false);
  /** The applied query; null = none (administrator: the department-wide view). */
  const [applied, setApplied] = useState<AppliedQuery | null>(null);

  const appliedRef = useRef<AppliedQuery | null>(null);
  const shownKey = useRef<string | null>(null);
  const request = useRef(0);
  const retryRef = useRef<() => void>(() => undefined);
  const reloadMetaRef = useRef(reloadMeta);
  useEffect(() => {
    reloadMetaRef.current = reloadMeta;
  });

  const commitApplied = useCallback((query: AppliedQuery | null) => {
    appliedRef.current = query;
    setApplied(query);
  }, []);

  const run = useCallback(
    (query: AppliedQuery) =>
      api<SearchResponse>(`${base}/search`, {
        method: "POST",
        body: { ...(query.link && { link: query.link }), ...(query.root && { root: query.root }), sort: query.sort, offset: query.offset, limit: query.limit },
      }),
    [base],
  );

  /** Back to the initial builder and the default URL: replacing a refused link, or as a new history entry (Clear). */
  const reset = useCallback(
    (message: Notice, history: "replace" | "push") => {
      request.current++;
      const initial = initialBuilder();
      setRoot(initial.root);
      setLink(initial.link);
      setIssues(new Map());
      setLinkIssue(null);
      setNotice(message);
      setResult(null);
      setStale(false);
      setLoadError(null);
      setRunning(false);
      shownKey.current = null;
      if (history === "push") router.push(pathname, { scroll: false });
      else router.replace(pathname, { scroll: false });
    },
    [initialBuilder, router, pathname],
  );

  const runApplied = useCallback(
    (query: AppliedQuery, keepRows: boolean) => {
      const id = ++request.current;
      retryRef.current = () => runAppliedRef.current(query, false);
      setLoadError(null);
      setRunning(true);
      setStale(keepRows);
      if (!keepRows) setResult(null);
      run(query)
        .then((r) => {
          if (id !== request.current) return;
          setResult(r);
          setStale(false);
          commitApplied({ ...query, sort: r.sort, offset: r.offset, limit: r.limit });
        })
        .catch((e: unknown) => {
          if (id !== request.current) return;
          if (e instanceof ApiError && SEARCH_ERRORS_FROM_LINK.includes(e.status)) {
            // A tampered or outdated link: the server refused it.
            reset({ tone: "danger", title: "The query in this link was refused", text: `${sentence(e.message)} The builder was reset.` }, "replace");
            if (e.code === "CITATION_DATA_UNAVAILABLE") reloadMetaRef.current();
            return;
          }
          setResult(null);
          setStale(false);
          setLoadError(e);
        })
        .finally(() => {
          if (id === request.current) setRunning(false);
        });
    },
    [run, commitApplied, reset],
  );
  const runAppliedRef = useRef(runApplied);
  useEffect(() => {
    runAppliedRef.current = runApplied;
  });

  // The URL is the applied query: restore and run it (first load, reload, back / forward, paging, sorting).
  useEffect(() => {
    if (shownKey.current === urlKey) return;
    shownKey.current = urlKey; // handled once per URL, however often this component re-renders
    const search = new URLSearchParams(urlKey);
    const decoded = admin ? decodeQuery(search, pageDefault, { link: true }) : decodeQuery(search, pageDefault);
    if (!decoded.ok) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- state follows the URL; this effect is its subscriber
      reset({ tone: "danger", title: "The query in this link is invalid", text: "It could not be read, so the builder was reset. Build the query again and select Apply." }, "replace");
      return;
    }
    const query: AppliedQuery | null = decoded.query ?? (admin ? null : { sort: "year", offset: 0, limit: pageDefault });
    if (!query) {
      // Administrator without a query: the department-wide view, and the initial builder.
      request.current++;
      const initial = initialBuilder();
      setRoot(initial.root);
      setLink(initial.link);
      setIssues(new Map());
      setLinkIssue(null);
      setResult(null);
      setStale(false);
      setLoadError(null);
      setRunning(false);
      commitApplied(null);
      return;
    }
    // Same filter, another page or sort: keep the draft and show the previous rows while loading.
    const samePages = sameFilter(appliedRef.current, query);
    if (!samePages) {
      const restored = builderOf(query);
      setRoot(restored.root);
      setLink(restored.link);
      setIssues(new Map());
      setLinkIssue(null);
    }
    commitApplied(query);
    runApplied(query, samePages);
  }, [urlKey, admin, pageDefault, reset, initialBuilder, commitApplied, runApplied]);

  const appliedBuilderKey = useMemo(() => {
    if (!applied) return null;
    const restored = builderOf(applied);
    return builderKey(restored.root, restored.link, meta.fields, maxProfessors);
  }, [applied, meta.fields, maxProfessors]);
  /** The builder differs from the applied query (unsaved filter changes). */
  const dirty = appliedBuilderKey !== null && builderKey(root, link, meta.fields, maxProfessors) !== appliedBuilderKey;

  /** Apply: validate locally, run on the server, then record the query in the URL. */
  async function apply() {
    const tree = toApiTree(root, meta.fields);
    const scope = link ? linkToApi(link, maxProfessors) : null;
    if (tree.issues.size > 0 || scope?.issue) {
      setIssues(tree.issues);
      setLinkIssue(scope?.issue ?? null);
      const count = tree.issues.size + (scope?.issue ? 1 : 0);
      setNotice({ tone: "danger", title: "The query is incomplete", text: `Correct ${plural(count, "highlighted entry", "highlighted entries")} and select Apply again.` });
      return;
    }
    const query: AppliedQuery = {
      ...(scope && { link: scope.link }),
      ...(tree.root && { root: tree.root }),
      sort: applied?.sort ?? "year",
      offset: 0,
      limit: applied?.limit ?? pageDefault,
    };
    if (!fitsInUrl(query, pageDefault)) {
      // Such a query could not be restored from the page address (D11), so it is not run.
      setNotice({ tone: "danger", title: "The query is too long", text: "It cannot be kept in the page address. Shorten the text values or remove conditions, then select Apply." });
      return;
    }
    const id = ++request.current;
    setRunning(true);
    setLoadError(null);
    setIssues(new Map());
    setLinkIssue(null);
    setNotice(null);
    // The rows on screen stay those of the still-applied query until the new one answers; they are
    // not marked "updating", which is reserved for another page or order of the same query.
    setStale(false);
    try {
      const r = await run(query);
      if (id !== request.current) return;
      setResult(r);
      setStale(false);
      const done = { ...query, sort: r.sort, offset: r.offset, limit: r.limit };
      commitApplied(done);
      const search = encodeQuery(done, pageDefault).toString();
      shownKey.current = search;
      router.push(search ? `${pathname}?${search}` : pathname, { scroll: false });
    } catch (e) {
      if (id !== request.current) return;
      setStale(false);
      if (e instanceof ApiError && (e.code === "VALIDATION_ERROR" || e.code === "PROFESSOR_NOT_FOUND")) {
        // Not applied: the previously applied query and its rows stay.
        const { byNode, general } = mapServerIssues(root, e.details);
        const linkMessages = (Array.isArray(e.details) ? (e.details as { path?: unknown; message?: unknown }[]) : [])
          .filter((d) => typeof d.path === "string" && d.path.startsWith("link"))
          .map((d) => String(d.message));
        setIssues(byNode);
        setLinkIssue(e.code === "PROFESSOR_NOT_FOUND" ? "One or more selected professors no longer exist. Remove them and apply again." : linkMessages[0] ?? null);
        setNotice({
          tone: "danger",
          title: "The query was not accepted",
          text: [e.message, ...general.filter((g) => !linkMessages.includes(g))].map(sentence).join(" "),
        });
      } else if (e instanceof ApiError && e.code === "CITATION_DATA_UNAVAILABLE") {
        setNotice({ tone: "warning", title: "Scopus citation data is unavailable", text: "Citation conditions and sorting cannot be used now. Remove them and select Apply again." });
        reloadMeta();
      } else {
        retryRef.current = () => void apply();
        setResult(null);
        setLoadError(e);
      }
    } finally {
      if (id === request.current) setRunning(false);
    }
  }

  /** Discard: the builder goes back to the applied query (or the initial builder when none is applied). */
  function discard() {
    const restored = applied ? builderOf(applied) : initialBuilder();
    setRoot(restored.root);
    setLink(restored.link);
    setIssues(new Map());
    setLinkIssue(null);
    setNotice(null);
  }

  /** Clear: no query (administrator: the department-wide view; professor: the empty builder). */
  function clear() {
    if (urlKey) {
      reset(null, "push"); // Back returns to the cleared query
      return;
    }
    // Already at the default URL, which does not change.
    reset(null, "replace");
    shownKey.current = "";
    if (admin) {
      commitApplied(null);
    } else {
      const query: AppliedQuery = { sort: "year", offset: 0, limit: pageDefault };
      commitApplied(query);
      runApplied(query, false);
    }
  }

  /** Sorting and paging act on the applied query; they are paused while the builder has unsaved changes. */
  function navigate(next: Partial<AppliedQuery>) {
    if (!applied || dirty) return;
    const search = encodeQuery({ ...applied, ...next }, pageDefault).toString();
    if (search === urlKey) return;
    // Mark the rows as updating from the first render after the click, not only once the URL effect runs.
    if (result) {
      setStale(true);
      setRunning(true);
    }
    router.push(search ? `${pathname}?${search}` : pathname, { scroll: false });
  }

  /** Runs the applied query again (same page and order), e.g. after the data changed; the rows stay, marked as updating. */
  function refresh() {
    if (applied) runApplied(applied, result !== null);
  }

  /** A preset replaces the builder (and, for the administrator, the link scope); it runs on Apply. */
  function loadPreset(query: { root: ApiGroup; link?: ApiLinkScope }) {
    setRoot(fromApiTree(query.root));
    if (admin && query.link) setLink(linkDraftOf(query.link));
    setIssues(new Map());
    setLinkIssue(null);
    setNotice({ tone: "info", title: "Preset loaded", text: "Adjust it if you like, then select Apply." });
  }

  return {
    root,
    setRoot,
    link,
    setLink,
    issues,
    linkIssue,
    notice,
    result,
    stale,
    loadError,
    running,
    applied,
    dirty,
    apply,
    discard,
    clear,
    navigate,
    loadPreset,
    refresh,
    retry: () => retryRef.current(),
  };
}

export type Workspace = ReturnType<typeof useQueryWorkspace>;

/* ── Notices and the unsaved-changes note ──────────────────────────────── */

export function WorkspaceNotice({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <Alert tone={notice.tone} role="alert" title={notice.title}>
      {notice.text}
    </Alert>
  );
}

/** "Unsaved filter changes" with Apply and Discard (shown while the builder differs from the applied query). */
export function UnsavedChanges({ workspace }: { workspace: Workspace }) {
  if (!workspace.dirty) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-warning bg-warning-bg px-3 py-2" data-unsaved-changes>
      <p className="text-[15px] text-text">
        <span className="font-medium">Unsaved filter changes.</span> The results show the last applied query.
      </p>
      <div className="ml-auto flex gap-2">
        <Button compact variant="primary" onClick={() => void workspace.apply()} loading={workspace.running} loadingLabel="Applying…">
          Apply
        </Button>
        <Button compact variant="quiet" icon={<RotateCcw aria-hidden size={16} />} onClick={workspace.discard}>
          Discard changes
        </Button>
      </div>
    </div>
  );
}

/* ── Presets ───────────────────────────────────────────────────────────── */

export function PresetPicker({
  base,
  presets,
  error,
  onLoad,
  selectedProfessors = [],
}: {
  base: string;
  presets: PresetMeta[] | null;
  error: unknown;
  onLoad: (query: { root: ApiGroup; link?: ApiLinkScope }) => void;
  /** For a preset whose parameter is the selected professors (administrator). */
  selectedProfessors?: string[];
}) {
  const [id, setId] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const preset = presets?.find((p) => p.id === id);
  const textParameter = preset?.parameter === "year" || preset?.parameter === "text";

  async function load() {
    if (!preset) return;
    let parameter: string | undefined;
    if (textParameter) {
      if (!value.trim()) {
        setProblem(preset.parameter === "year" ? "Enter a year" : "Enter a value");
        return;
      }
      parameter = value.trim();
    } else if (preset.parameter === "professors") {
      if (new Set(selectedProfessors).size < 2) {
        setProblem("Select at least two professors under “Selected professors” first.");
        return;
      }
      parameter = selectedProfessors.join(",");
    }
    setBusy(true);
    setProblem(null);
    try {
      const qs = parameter !== undefined ? `?${new URLSearchParams({ value: parameter })}` : "";
      const { query } = await api<{ query: { root: ApiGroup; link?: ApiLinkScope } }>(`${base}/presets/${encodeURIComponent(preset.id)}${qs}`);
      onLoad(query);
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (error && !presets) return <p className="text-[13px] text-danger">Predefined filters could not be loaded: {errorMessage(error)}</p>;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex w-full min-w-0 flex-col gap-1.5 sm:w-auto">
          <span className="text-[13px] leading-[18px] font-medium">Start from a predefined filter</span>
          <select
            className="input w-full max-w-full sm:w-auto sm:min-w-[16rem]"
            value={id}
            disabled={!presets}
            onChange={(e) => {
              setId(e.target.value);
              setValue("");
              setProblem(null);
            }}
          >
            <option value="">Choose a filter…</option>
            {presets?.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.available}>
                {p.available ? p.label : `${p.label} (${p.unavailableReason ?? "unavailable"})`}
              </option>
            ))}
          </select>
        </label>
        {textParameter && (
          <label className="flex min-w-0 flex-col gap-1.5 max-sm:w-full">
            <span className="text-[13px] leading-[18px] font-medium">{preset?.parameter === "year" ? "Year" : "Text"}</span>
            <input
              className={`input ${preset?.parameter === "year" ? "w-28" : "w-full sm:w-56"}`}
              inputMode={preset?.parameter === "year" ? "numeric" : undefined}
              maxLength={300}
              value={value}
              aria-invalid={problem ? true : undefined}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void load();
              }}
            />
          </label>
        )}
        <Button icon={<Wand2 aria-hidden size={16} />} disabled={!preset} onClick={() => void load()} loading={busy} loadingLabel="Loading…">
          Use filter
        </Button>
      </div>
      {preset?.parameter === "professors" && (
        <p className="text-[13px] text-text-muted">Uses the {plural(selectedProfessors.length, "professor")} currently selected under “Selected professors”.</p>
      )}
      {problem && (
        <p role="alert" className="text-[13px] text-danger">
          {problem}
        </p>
      )}
      <p className="text-[13px] text-text-muted">A predefined filter replaces the query below; nothing runs until you select Apply.</p>
    </div>
  );
}

/* ── Results ───────────────────────────────────────────────────────────── */

const PAGE_SIZES = [25, 50, 100];

export function QueryResults({
  workspace,
  sorts,
  admin,
  emptyText,
  exportPath,
}: {
  workspace: Workspace;
  sorts: QueryFieldsResponse["sorts"];
  admin: boolean;
  emptyText: string;
  /** Administrator: CSV download of the applied query's matching publications (decision #168). */
  exportPath?: string;
}) {
  const { result, loadError, running, stale, applied, dirty } = workspace;
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);

  /** Downloads the applied query's rows (the server runs and validates the query again; no IDs are sent). */
  async function download() {
    if (!applied || !exportPath) return;
    setDownloading(true);
    try {
      const body = { ...(applied.link && { link: applied.link }), ...(applied.root && { root: applied.root }), sort: applied.sort };
      await downloadFile(exportPath, "publication-query.csv", { method: "POST", body });
    } catch (error) {
      toast(`The download failed: ${errorMessage(error)}`, "danger");
    } finally {
      setDownloading(false);
    }
  }
  const sort: SortKey = applied?.sort ?? "year";
  const limit = applied?.limit ?? PAGE_SIZES[0];
  const showCitations = result?.citations.available === true;
  const updating = stale && running && result !== null;
  // Paging and sorting are paused while the builder has unsaved changes.
  const locked = dirty;
  const lockedNote = "Apply or discard your filter changes to change the page or the sorting.";

  return (
    <Panel labelledBy="query-results">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 id="query-results" className="text-lg font-semibold">
            {admin ? "Matching publications" : "Results"}
          </h2>
          <p className="text-[13px] text-text-muted tabular-nums" aria-live="polite">
            {running && !updating ? "Running the query…" : result ? plural(result.total, "publication") : " "}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex w-full min-w-0 flex-col gap-1 sm:w-auto">
            <span className="text-[13px] font-medium">Sort by</span>
            <select
              className="input w-full max-w-full sm:w-auto"
              value={sort}
              disabled={locked || !applied}
              title={locked ? lockedNote : undefined}
              onChange={(e) => workspace.navigate({ sort: e.target.value as SortKey, offset: 0 })}
            >
              {sorts.map((s) => (
                <option key={s.key} value={s.key} disabled={!s.available}>
                  {SORT_LABEL[s.key]}
                  {s.available ? "" : " (Scopus data unavailable)"}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[13px] font-medium">Per page</span>
            <select
              className="input w-auto"
              value={limit}
              disabled={locked || !applied}
              title={locked ? lockedNote : undefined}
              onChange={(e) => workspace.navigate({ limit: Number(e.target.value), offset: 0 })}
            >
              {(PAGE_SIZES.includes(limit) ? PAGE_SIZES : [...PAGE_SIZES, limit].sort((a, b) => a - b)).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          {exportPath && (
            <Button
              compact
              icon={<FileDown aria-hidden size={16} />}
              onClick={() => void download()}
              loading={downloading}
              disabled={locked || !applied || !result || result.total === 0}
              aria-label={downloading ? "Preparing the CSV download" : "Download the matching publications as CSV"}
              title={locked ? lockedNote.replace("change the page or the sorting", "download") : "Download the matching publications as CSV"}
            />
          )}
        </div>
      </div>

      {locked && result && <p className="border-b border-border bg-surface-sunken px-4 py-2 text-[13px] text-text-muted">{lockedNote}</p>}
      {updating && (
        <p role="status" className="flex items-center gap-2 border-b border-border bg-info-bg px-4 py-2 text-[13px] text-text" data-updating>
          <LoaderCircle aria-hidden size={16} className="animate-spin text-info" />
          Updating — the rows below are still the previous page or order of this query.
        </p>
      )}

      {loadError ? (
        <div className="p-4">
          <LoadError error={loadError} onRetry={workspace.retry} />
        </div>
      ) : !result ? (
        <SkeletonRows rows={6} label="Loading results" />
      ) : result.publications.length === 0 && result.total > 0 ? (
        <EmptyState action={<Button onClick={() => workspace.navigate({ offset: 0 })} disabled={locked}>Go to the first page</Button>}>
          This page is past the end of the results ({plural(result.total, "publication")} in total).
        </EmptyState>
      ) : result.publications.length === 0 ? (
        <EmptyState>{emptyText}</EmptyState>
      ) : (
        <div className={updating ? "opacity-60 transition-opacity" : undefined} aria-busy={updating || undefined}>
          {result.citations.available && (
            <p className="border-b border-border px-4 py-2 text-[13px] text-text-muted tabular-nums">
              Scopus counts: {formatNumber(result.citations.coverage.withCount)} with a count · {formatNumber(result.citations.coverage.noCountYet)} no count yet ·{" "}
              {formatNumber(result.citations.coverage.notInScopus)} not in Scopus
              {result.citations.latestObservation && <> · latest observation {formatDate(result.citations.latestObservation)}</>}
            </p>
          )}
          {!result.citations.available && (
            <p className="border-b border-border px-4 py-2 text-[13px] text-text-muted">Scopus citation data unavailable.</p>
          )}
          <div className="overflow-x-auto">
            <table className="data-table">
              <caption className="sr-only">
                {admin ? "Matching publications" : "Query results"}, {result.total} in total
              </caption>
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th scope="col">Year</th>
                  <th scope="col" className="max-lg:hidden">
                    Type
                  </th>
                  <th scope="col">Sources</th>
                  {admin && <th scope="col">Professors</th>}
                  {admin && <th scope="col">Status</th>}
                  {showCitations && <th scope="col">Scopus citations</th>}
                </tr>
              </thead>
              <tbody>
                {result.publications.map((p) => (
                  <ResultRow key={p.id} row={p} showCitations={showCitations} admin={admin} />
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            offset={result.offset}
            limit={result.limit}
            count={result.publications.length}
            total={result.total}
            disabled={locked || updating}
            onPage={(offset) => workspace.navigate({ offset })}
          />
        </div>
      )}
    </Panel>
  );
}

function ResultRow({ row, showCitations, admin }: { row: QueryRow; showCitations: boolean; admin: boolean }) {
  const meta = [row.authorNamesDisplay, row.venue].filter(Boolean).join(" · ");
  const type = TYPE_LABEL[row.typeFamily as TypeFamily] ?? row.typeFamily;
  return (
    <tr>
      <td className="no-label min-w-[16rem]">
        <p className="font-serif text-base leading-6 font-medium">{row.title}</p>
        {meta && (
          <p className="mt-0.5 line-clamp-2 text-[13px] leading-5 text-text-muted" title={meta}>
            <span className="lg:hidden">{type} · </span>
            {meta}
          </p>
        )}
        {row.doi && (
          <p className="mt-1">
            <Doi doi={row.doi} />
          </p>
        )}
      </td>
      <td data-label="Year" className="tabular-nums whitespace-nowrap">
        {row.year ?? <span className="text-text-muted">Unknown</span>}
      </td>
      <td data-label="Type" className="text-[13px] whitespace-nowrap max-lg:hidden">
        {type}
      </td>
      <td data-label="Sources">
        <SourceChips sources={row.sources as Source[]} />
      </td>
      {admin && (
        <td data-label="Professors" className="min-w-[12rem]">
          <ProfessorsCell row={row} />
        </td>
      )}
      {admin && (
        <td data-label="Status">
          <div className="flex flex-col items-start gap-1">
            {row.status && <StatusChip status={row.status} />}
            {row.isCurated && <CuratedChip />}
          </div>
        </td>
      )}
      {showCitations && (
        <td data-label="Scopus citations">
          <CitationCell row={row} />
        </td>
      )}
    </tr>
  );
}

/**
 * Administrator only (§24.7, D10): every linked professor with the relationship status; links that
 * satisfy the link scope are marked as qualifying, selected professors first (server order).
 */
function ProfessorsCell({ row }: { row: QueryRow }) {
  const professors = row.professors ?? [];
  if (professors.length === 0) return <span className="text-[13px] text-text-muted">No professor link</span>;
  const qualifying = professors.filter((p) => p.qualifying).length;
  return (
    <div className="flex flex-col gap-1 text-[13px] leading-5">
      <p className="text-text-muted tabular-nums" data-linked-count>
        {plural(qualifying, "qualifying link")} · {plural(professors.length, "professor")} linked
      </p>
      <ul className="flex flex-col gap-0.5">
        {professors.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-1.5">
            <span className={p.selected ? "font-semibold" : undefined}>{p.name}</span>
            {p.selected && <span className="text-text-muted">(selected)</span>}
            {!p.isActive && <span className="text-text-muted">(inactive)</span>}
            <StatusChip status={p.status} />
            {p.qualifying && <span className="text-success">✓ qualifies</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The three citation states (#157), decided by the server's state — never by a missing count. */
function CitationCell({ row }: { row: QueryRow }) {
  const shown = citationDisplay(row);
  switch (shown.kind) {
    case "count":
    case "zero": {
      const c = shown.citation;
      return (
        <div className="text-[13px] leading-5" data-citation-state="COUNTED">
          <p className="font-medium tabular-nums">
            {formatNumber(c.count)} {c.count === 1 ? "citation" : "citations"}
          </p>
          <p className="text-text-muted">Scopus, as of {formatDate(c.observedAt)}</p>
          {(c.recordUrl || c.citedByUrl) && (
            <p className="flex flex-wrap gap-x-2">
              {c.recordUrl && <ExternalProfileLink href={c.recordUrl}>View in Scopus</ExternalProfileLink>}
              {c.citedByUrl && <ExternalProfileLink href={c.citedByUrl}>Citing documents</ExternalProfileLink>}
            </p>
          )}
        </div>
      );
    }
    case "noCountYet":
      return (
        <p className="text-[13px] text-text-muted" data-citation-state="NO_COUNT_YET">
          No Scopus count yet
        </p>
      );
    case "notInScopus":
      return (
        <p className="text-[13px] text-text-muted" data-citation-state="NOT_IN_SCOPUS">
          Not in Scopus
        </p>
      );
    default:
      return <span className="text-text-muted">–</span>;
  }
}
