"use client";

import { useId } from "react";
import { FolderPlus, Plus, Trash2 } from "lucide-react";
import { Button } from "./ui";
import { SOURCE_LABEL, TYPE_LABEL } from "@/lib/format";
import {
  addChild,
  BuilderCondition,
  BuilderGroup,
  countConditions,
  DraftValue,
  FieldMeta,
  newCondition,
  newGroup,
  OPERATOR_LABEL,
  QueryFieldsResponse,
  removeNode,
  setField,
  setOperator,
  updateNode,
  valueKind,
} from "@/lib/query-builder";
import type { Source, TypeFamily } from "@/lib/types";

/**
 * The visual condition builder (Project_plan.md §24.8; stage Q2): nested AND / OR groups of
 * conditions whose fields, operators and value kinds come from the server's field metadata.
 * Fields the server reports as unavailable (Scopus citations without Scopus data, D6) are shown
 * disabled with their reason and cannot be chosen. Limits (conditions, depth, group size) follow
 * the server's; the server validates every applied query again.
 */

const OPTION_LABEL: Record<string, string> = { ...TYPE_LABEL, ...SOURCE_LABEL, ACTIVE: "Active", SUPPRESSED: "Suppressed" };

export function QueryBuilder({
  root,
  onChange,
  meta,
  issues,
  emptyText,
}: {
  root: BuilderGroup;
  onChange: (root: BuilderGroup) => void;
  meta: QueryFieldsResponse;
  issues: Map<string, string>;
  /** Shown while the root group has no conditions. */
  emptyText: string;
}) {
  const total = countConditions(root);
  return (
    <GroupEditor group={root} root={root} depth={1} total={total} onChange={onChange} meta={meta} issues={issues} emptyText={emptyText} />
  );
}

function GroupEditor({
  group,
  root,
  depth,
  total,
  onChange,
  meta,
  issues,
  emptyText,
}: {
  group: BuilderGroup;
  root: BuilderGroup;
  depth: number;
  total: number;
  onChange: (root: BuilderGroup) => void;
  meta: QueryFieldsResponse;
  issues: Map<string, string>;
  emptyText: string;
}) {
  const labelId = useId();
  const isRoot = group.id === root.id;
  const full = group.children.length >= meta.limits.groupChildren;
  const atConditionLimit = total >= meta.limits.conditions;
  const canNest = depth < meta.limits.depth;
  const issue = issues.get(group.id);
  const combinatorWord = group.combinator === "AND" ? "all" : "any";

  return (
    <fieldset
      aria-labelledby={labelId}
      className={isRoot ? "flex flex-col gap-3" : "flex flex-col gap-3 rounded-md border border-border-strong bg-surface-sunken/40 p-3"}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span id={labelId} className="text-[15px]">
          {isRoot ? "Publications matching" : "A group matching"}
        </span>
        <select
          className="input w-auto min-w-[6.5rem]"
          aria-label={isRoot ? "Combine the conditions with" : "Combine this group's conditions with"}
          value={group.combinator}
          onChange={(e) => onChange(updateNode(root, group.id, (n) => ({ ...(n as BuilderGroup), combinator: e.target.value as "AND" | "OR" })))}
        >
          <option value="AND">all</option>
          <option value="OR">any</option>
        </select>
        <span className="text-[15px]">of these conditions</span>
        {!isRoot && (
          <Button
            variant="quiet"
            compact
            icon={<Trash2 aria-hidden size={16} />}
            className="ml-auto"
            onClick={() => onChange(removeNode(root, group.id))}
          >
            Remove group
          </Button>
        )}
      </div>

      {group.children.length === 0 && isRoot && (
        <p className="text-[13px] text-text-muted">{emptyText}</p>
      )}

      {group.children.length > 0 && (
        <ol className="flex flex-col gap-2" aria-label={`Conditions (match ${combinatorWord})`}>
          {group.children.map((child) => (
            <li key={child.id}>
              {child.kind === "group" ? (
                <GroupEditor group={child} root={root} depth={depth + 1} total={total} onChange={onChange} meta={meta} issues={issues} emptyText={emptyText} />
              ) : (
                <ConditionRow condition={child} root={root} onChange={onChange} fields={meta.fields} issue={issues.get(child.id)} />
              )}
            </li>
          ))}
        </ol>
      )}

      {issue && (
        <p role="alert" className="text-[13px] text-danger">
          {issue}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          compact
          icon={<Plus aria-hidden size={16} />}
          disabled={full || atConditionLimit}
          onClick={() => onChange(addChild(root, group.id, newCondition(meta.fields)))}
        >
          Add condition
        </Button>
        {canNest && (
          <Button
            compact
            variant="quiet"
            icon={<FolderPlus aria-hidden size={16} />}
            disabled={full || atConditionLimit}
            onClick={() => onChange(addChild(root, group.id, newGroup(meta.fields)))}
          >
            Add group
          </Button>
        )}
        {isRoot && atConditionLimit && <p className="self-center text-[13px] text-text-muted">At most {meta.limits.conditions} conditions.</p>}
        {!atConditionLimit && full && <p className="self-center text-[13px] text-text-muted">A group holds at most {meta.limits.groupChildren} entries.</p>}
      </div>
    </fieldset>
  );
}

function ConditionRow({
  condition,
  root,
  onChange,
  fields,
  issue,
}: {
  condition: BuilderCondition;
  root: BuilderGroup;
  onChange: (root: BuilderGroup) => void;
  fields: FieldMeta[];
  issue?: string;
}) {
  const id = useId();
  const field = fields.find((f) => f.id === condition.field);
  const kind = valueKind(fields, condition.field, condition.operator);
  const errorId = issue ? `${id}-error` : undefined;
  const setValue = (value: DraftValue) => onChange(updateNode(root, condition.id, (n) => ({ ...(n as BuilderCondition), value })));
  const fieldName = field?.label ?? "Condition";

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-surface p-3" data-node={condition.id}>
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        <select
          className="input w-full max-w-full sm:w-auto sm:min-w-[10rem]"
          aria-label="Field"
          aria-invalid={issue ? true : undefined}
          aria-describedby={errorId}
          value={condition.field}
          onChange={(e) => onChange(setField(root, condition.id, fields, e.target.value))}
        >
          {!field && <option value={condition.field}>Unknown field</option>}
          {fields.map((f) => (
            <option key={f.id} value={f.id} disabled={!f.available}>
              {f.available ? f.label : `${f.label} (${f.unavailableReason ?? "unavailable"})`}
            </option>
          ))}
        </select>
        <select
          className="input w-full max-w-full sm:w-auto sm:min-w-[9rem]"
          aria-label={`${fieldName}: operator`}
          value={condition.operator}
          onChange={(e) => onChange(setOperator(root, condition.id, fields, e.target.value))}
        >
          {!kind && <option value={condition.operator}>Choose an operator</option>}
          {field?.operators.map((o) => (
            <option key={o.operator} value={o.operator}>
              {OPERATOR_LABEL[o.operator] ?? o.operator}
            </option>
          ))}
        </select>
        {kind && <ValueInput kind={kind} value={condition.value} onChange={setValue} options={field?.options ?? []} label={fieldName} invalid={!!issue} describedBy={errorId} />}
        <Button
          variant="quiet"
          compact
          icon={<Trash2 aria-hidden size={16} />}
          aria-label={`Remove the condition on ${fieldName}`}
          title="Remove condition"
          className="ml-auto"
          onClick={() => onChange(removeNode(root, condition.id))}
        />
      </div>
      {issue && (
        <p id={errorId} className="text-[13px] text-danger">
          {issue}
        </p>
      )}
    </div>
  );
}

function ValueInput({
  kind,
  value,
  onChange,
  options,
  label,
  invalid,
  describedBy,
}: {
  kind: NonNullable<ReturnType<typeof valueKind>>;
  value: DraftValue;
  onChange: (value: DraftValue) => void;
  options: string[];
  label: string;
  invalid: boolean;
  describedBy?: string;
}) {
  const common = { "aria-invalid": invalid || undefined, "aria-describedby": describedBy };
  const pair = Array.isArray(value) && value.length === 2 ? (value as [string, string]) : (["", ""] as [string, string]);
  const one = typeof value === "string" ? value : "";
  switch (kind) {
    case "none":
      return null;
    case "year":
    case "count":
      return (
        <input
          {...common}
          className="input w-28"
          inputMode="numeric"
          aria-label={`${label}: ${kind === "year" ? "year" : "number"}`}
          placeholder={kind === "year" ? "e.g. 2024" : "e.g. 10"}
          value={one}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "yearRange":
    case "countRange":
    case "dateRange": {
      const type = kind === "dateRange" ? "date" : "text";
      const width = kind === "dateRange" ? "w-40" : "w-28";
      return (
        <span className="flex flex-wrap items-center gap-2">
          <input
            {...common}
            type={type}
            inputMode={type === "text" ? "numeric" : undefined}
            className={`input ${width}`}
            aria-label={`${label}: from`}
            value={pair[0]}
            onChange={(e) => onChange([e.target.value, pair[1]])}
          />
          <span className="text-[15px] text-text-muted">and</span>
          <input
            {...common}
            type={type}
            inputMode={type === "text" ? "numeric" : undefined}
            className={`input ${width}`}
            aria-label={`${label}: to`}
            value={pair[1]}
            onChange={(e) => onChange([pair[0], e.target.value])}
          />
        </span>
      );
    }
    case "date":
      return <input {...common} type="date" className="input w-40" aria-label={`${label}: date`} value={one} onChange={(e) => onChange(e.target.value)} />;
    case "text":
      return (
        <input
          {...common}
          className="input w-full sm:w-auto sm:min-w-[12rem] sm:flex-1"
          maxLength={300}
          aria-label={`${label}: text`}
          value={one}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "boolean":
      return (
        <select {...common} className="input w-auto" aria-label={`${label}: value`} value={one} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      );
    case "types":
    case "sources":
    case "statuses": {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1.5 py-1.5" aria-label={`${label}: values`} aria-describedby={describedBy}>
          {options.map((o) => (
            <label key={o} className="inline-flex cursor-pointer items-center gap-2 text-[15px]">
              <input
                type="checkbox"
                className="size-4 cursor-pointer accent-[var(--ink)]"
                checked={selected.includes(o)}
                onChange={(e) => onChange(e.target.checked ? [...selected, o] : selected.filter((s) => s !== o))}
              />
              {OPTION_LABEL[o as TypeFamily | Source] ?? o}
            </label>
          ))}
        </fieldset>
      );
    }
  }
}

