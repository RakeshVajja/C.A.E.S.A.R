import { PrismaClient } from '@prisma/client';
import { prisma as defaultClient } from '../../config/database';
import { HttpError } from '../../utils/httpError';
import { csvField } from '../verification/approvedExport';
import { AdminQuery, parseQuery } from './ast';
import { compareByCitations, inQueryTransaction, loadRows, matchingFilter, ORDER } from './execute';

/**
 * The administrator's matching publications as a CSV file (decision #168, an owner-approved
 * amendment of §24 D14; stage after Q5). The file is the results table as rows and columns — every
 * matching publication, in the table's sort order — and nothing else: no analytics, and no
 * citation counts or other provider-derived figures (canonical metadata only, as #153). The query
 * is validated, scoped and executed exactly as by the search (`matchingFilter`, one read-only
 * REPEATABLE READ transaction with the statement timeout); no row IDs from the client are used.
 * The downloaded file is a copy outside the database, which provider-data removal cannot reach
 * (§13.10).
 *
 * Format as the My publications export (#153): RFC 4180, CRLF, every field quoted and
 * formula-safe (`csvField`), UTF-8 with a byte-order mark.
 */

export const QUERY_EXPORT_COLUMNS = ['Title', 'Year', 'Type', 'Venue', 'Authors', 'DOI', 'Sources', 'Publication status', 'Curated', 'Linked professors'] as const;

/** At most this many rows per file; a larger result is refused (narrow the query). */
export const QUERY_EXPORT_MAX_ROWS = 10_000;

const TYPE_LABEL: Record<string, string> = {
  JOURNAL: 'Journal article',
  CONFERENCE: 'Conference paper',
  BOOK_CHAPTER: 'Book chapter',
  BOOK: 'Book',
  PREPRINT: 'Preprint',
  OTHER: 'Other',
};
const SOURCE_LABEL: Record<string, string> = {
  OPENALEX: 'OpenAlex',
  DBLP: 'DBLP',
  ORCID: 'ORCID',
  SCOPUS: 'Scopus',
  WOS: 'Web of Science',
  MANUAL: 'Manual entry',
};
const STATUS_LABEL: Record<string, string> = { APPROVED: 'Approved', PENDING: 'Pending', REJECTED: 'Rejected', ACTIVE: 'Active', SUPPRESSED: 'Suppressed' };

export async function queryResultsCsv(
  body: unknown,
  client: PrismaClient = defaultClient,
  options: { statementTimeoutMs?: number; maxRows?: number } = {},
): Promise<{ csv: string; rows: number }> {
  const query: AdminQuery = parseQuery('ADMIN', body);
  const maxRows = options.maxRows ?? QUERY_EXPORT_MAX_ROWS;
  return inQueryTransaction(client, options.statementTimeoutMs, async (tx) => {
    const { where, citations, link } = await matchingFilter(tx, { role: 'ADMIN' }, query);
    // Every matching ID in the table's order (sort key, then id).
    let ids: string[];
    if (query.sort === 'scopusCitations') {
      ids = (await tx.publication.findMany({ where, select: { id: true } })).map((p) => p.id);
      ids.sort((a, b) => compareByCitations(citations!, a, b));
    } else {
      ids = (await tx.publication.findMany({ where, select: { id: true }, orderBy: ORDER[query.sort] })).map((p) => p.id);
    }
    if (ids.length > maxRows) {
      throw new HttpError(400, 'EXPORT_TOO_LARGE', `At most ${maxRows} publications can be downloaded at once; narrow the query`);
    }
    // The table's rows (admin data included), without citation data.
    const rows = await loadRows(tx, { role: 'ADMIN' }, link, ids, false);
    const lines = [QUERY_EXPORT_COLUMNS.map(csvField).join(',')];
    for (const r of rows) {
      const professors = (r.professors ?? []).map((p) => {
        const marks = [STATUS_LABEL[p.status] ?? p.status, ...(p.qualifying ? ['qualifying'] : []), ...(p.selected ? ['selected'] : []), ...(p.isActive ? [] : ['inactive'])];
        return `${p.name} (${marks.join(', ')})`;
      });
      lines.push(
        [
          r.title,
          r.year,
          TYPE_LABEL[r.typeFamily] ?? r.typeFamily,
          r.venue,
          r.authorNamesDisplay,
          r.doi,
          r.sources.map((s) => SOURCE_LABEL[s] ?? s).join('; '),
          STATUS_LABEL[r.status ?? ''] ?? r.status ?? null,
          r.isCurated ? 'Yes' : 'No',
          professors.join('; '),
        ]
          .map(csvField)
          .join(','),
      );
    }
    return { csv: `﻿${lines.join('\r\n')}\r\n`, rows: rows.length };
  });
}
