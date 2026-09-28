import { z } from 'zod';

/**
 * Structural validation of SPARQL 1.1 JSON results from sparql.dblp.org (Project_plan.md §13.1).
 * dblp's endpoint (QLever) adds `meta.result-size-total`; it is required, because it is the
 * completeness check (decision #41) — a result without it is invalid, never silently accepted.
 */

export const SparqlTermSchema = z.looseObject({
  type: z.enum(['uri', 'literal', 'bnode', 'typed-literal']),
  value: z.string(),
  datatype: z.string().optional(),
});
export type SparqlTerm = z.infer<typeof SparqlTermSchema>;

export const SparqlResultsSchema = z.looseObject({
  head: z.looseObject({ vars: z.array(z.string()) }),
  results: z.looseObject({ bindings: z.array(z.record(z.string(), SparqlTermSchema)) }),
  meta: z.looseObject({ 'result-size-total': z.number().int().nonnegative() }),
});
export type SparqlResults = z.infer<typeof SparqlResultsSchema>;
export type SparqlBinding = SparqlResults['results']['bindings'][number];

/** One authored dblp record (one row of the records query), values as strings. */
export interface DblpRecordRow {
  publication: string;
  title: string | null;
  year: string | null;
  bibtexType: string | null;
  types: string[];
  dois: string[];
  venues: string[];
}

/** One author signature of an authored record (one row of the authors query). */
export interface DblpAuthorRow {
  publication: string;
  ordinal: number;
  name: string;
}

/** A record together with its ordered author names: what the mapper receives. */
export interface DblpPublication extends DblpRecordRow {
  authors: string[];
}
