import { PrismaClient, PublicationSource, TypeFamily } from '@prisma/client';
import { prisma as defaultClient } from '../../config/database';
import { SOURCE_PRIORITY } from '../matching/canonical';

/**
 * A professor's approved publications as a CSV file (decision #153, an approved exception to
 * "no export feature", Project_plan.md §22.4). Only the signed-in professor's APPROVED
 * relationships to ACTIVE publications; only canonical metadata — title, year, type, venue,
 * authors, DOI and the names of the sources that reported each publication. No citation counts,
 * raw metadata or other provider fields. The downloaded file is a copy outside the database, which
 * provider-data removal cannot reach (§13.10).
 *
 * Format: RFC 4180 (comma-separated, CRLF, every field quoted), UTF-8 with a byte-order mark so
 * spreadsheet programs read accents correctly. Text that a spreadsheet would run as a formula
 * (starting with =, +, -, @, tab or carriage return) is prefixed with an apostrophe.
 */

const TYPE_LABEL: Record<TypeFamily, string> = {
  JOURNAL: 'Journal article',
  CONFERENCE: 'Conference paper',
  BOOK_CHAPTER: 'Book chapter',
  BOOK: 'Book',
  PREPRINT: 'Preprint',
  OTHER: 'Other',
};

const SOURCE_LABEL: Record<PublicationSource, string> = {
  OPENALEX: 'OpenAlex',
  DBLP: 'DBLP',
  ORCID: 'ORCID',
  SCOPUS: 'Scopus',
  WOS: 'Web of Science',
  MANUAL: 'Manual entry',
};

export const EXPORT_COLUMNS = ['Title', 'Year', 'Type', 'Venue', 'Authors', 'DOI', 'Sources'] as const;

/** One CSV field: formula-safe, quoted, inner quotes doubled. */
export function csvField(value: string | number | null): string {
  let text = value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export async function approvedPublicationsCsv(professorId: string, client: PrismaClient = defaultClient): Promise<{ csv: string; rows: number }> {
  const links = await client.professorPublication.findMany({
    where: { professorId, status: 'APPROVED', publication: { status: 'ACTIVE' } },
    select: {
      publication: {
        select: {
          id: true,
          title: true,
          year: true,
          typeFamily: true,
          venue: true,
          authorNamesDisplay: true,
          doi: true,
          sourceRecords: { select: { source: true } },
        },
      },
    },
  });
  // Newest first, unknown years last, then by title (stable for a given set).
  const publications = links
    .map((l) => l.publication)
    .sort((a, b) => (b.year ?? -Infinity) - (a.year ?? -Infinity) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const lines = [EXPORT_COLUMNS.map(csvField).join(',')];
  for (const p of publications) {
    const sources = SOURCE_PRIORITY.filter((s) => p.sourceRecords.some((r) => r.source === s)).map((s) => SOURCE_LABEL[s]);
    lines.push(
      [p.title, p.year, TYPE_LABEL[p.typeFamily], p.venue, p.authorNamesDisplay, p.doi, sources.join('; ')].map(csvField).join(','),
    );
  }
  return { csv: `﻿${lines.join('\r\n')}\r\n`, rows: publications.length };
}
