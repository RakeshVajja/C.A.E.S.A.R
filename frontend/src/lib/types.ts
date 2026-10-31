/** Response shapes of the backend API (backend/src/routes, Phases 8–13B). */

export type Role = "ADMIN" | "PROFESSOR";
export type TypeFamily = "PREPRINT" | "CONFERENCE" | "JOURNAL" | "BOOK_CHAPTER" | "BOOK" | "OTHER";
export type Source = "OPENALEX" | "DBLP" | "ORCID" | "SCOPUS" | "WOS" | "MANUAL";
export type IdentitySource = "OPENALEX" | "DBLP" | "ORCID" | "SCOPUS" | "WOS";
export type VerificationStatus = "PENDING" | "APPROVED" | "REJECTED";
export type PublicationStatus = "ACTIVE" | "SUPPRESSED";
/** The basis of a curated value or manual entry (decision #125); PRE_PHASE15 is never chosen in the UI. */
export type DeclaredBasis = "INDEPENDENT" | "OPENALEX" | "DBLP" | "ORCID" | "SCOPUS" | "WOS" | "JCR";
export type Basis = DeclaredBasis | "PRE_PHASE15";
export type CuratedField = "title" | "year" | "venue" | "type_family" | "author_names_display" | "doi";
export type Curation = Partial<Record<CuratedField, { basis: Basis; evidence: string | null }>>;
export type CandidateStatus = "OPEN" | "MERGED" | "DISMISSED";
export type SyncRunStatus = "RUNNING" | "SUCCESS" | "PARTIAL_SUCCESS" | "FAILED";
export type SyncTaskStatus = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED" | "NOT_CONFIGURED";
/** Emailed sign-in details for a professor account (decision #102). */
export type InvitationStatus = "SENT" | "FAILED" | "NOT_CONFIGURED";

export interface User {
  id: string;
  email: string;
  role: Role;
  mustChangePassword: boolean;
  professor: { id: string; name: string } | null;
}

/* Professor-facing publications (/api/me/publications) */
export interface OwnItem {
  id: string;
  status: VerificationStatus;
  origin: "DISCOVERED" | "MANUAL" | "ADMIN";
  decidedAt: string | null;
  createdAt: string;
  publication: {
    id: string;
    title: string;
    year: number | null;
    venue: string | null;
    typeFamily: TypeFamily;
    doi: string | null;
    authorNamesDisplay: string | null;
    sources: Source[];
    scopusCitation: ScopusCitation | null;
  };
}
/**
 * A publication's Scopus citation count with the attribution links Scopus provided (decision #112).
 * Web of Science Times Cited and JCR metrics are never sent to the frontend (#112, #114).
 */
export interface ScopusCitation {
  count: number;
  observedAt: string;
  recordUrl: string | null;
  citedByUrl: string | null;
}
export interface OwnList {
  items: OwnItem[];
  total: number;
  limit: number;
  offset: number;
  counts: Record<VerificationStatus, number>;
}
export interface ManualResult {
  item: OwnItem;
  match: {
    outcome: "UPDATED_EXISTING" | "MATCHED_DOI" | "MATCHED_TITLE_YEAR" | "NEW_PUBLICATION";
    candidatesCreated: number;
    relationship: "CREATED" | "UPGRADED" | "UNCHANGED";
  };
}
export interface OwnProfile {
  id: string;
  name: string;
  department: string | null;
  designation: string | null;
  email: string;
}

/* Professors (/api/admin/professors) */
export interface ProfessorRow {
  id: string;
  name: string;
  department: string | null;
  designation: string | null;
  isActive: boolean;
  account: { email: string; mustChangePassword: boolean; activated: boolean; temporaryPasswordExpiresAt: string | null } | null;
  identityCount: number;
}
export type IdentityVerificationMethod = "API_PREVIEW" | "MANUAL_PROFILE" | "PRE_PHASE15";
export interface Identity {
  id: string;
  source: IdentitySource;
  externalId: string;
  isActive: boolean;
  verifiedAt: string | null;
  verificationMethod: IdentityVerificationMethod;
  verificationEvidenceUrl: string | null;
  createdAt: string;
}
export interface ProfessorDetail {
  id: string;
  name: string;
  department: string | null;
  designation: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  account: { id: string; email: string; mustChangePassword: boolean; activated: boolean; temporaryPasswordExpiresAt: string | null } | null;
  identities: Identity[];
}
export interface AccountResult {
  professor: ProfessorDetail;
  invitation?: { status: InvitationStatus };
}
export interface IdentityPreview {
  preview: {
    source: IdentitySource;
    externalId: string;
    // OpenAlex
    requestedId?: string;
    resolvedId?: string;
    merged?: boolean;
    displayName?: string | null;
    orcid?: string | null;
    worksCount?: number;
    warning?: string | null;
    // DBLP / ORCID
    pid?: string;
    name?: string | null;
    // Scopus
    authorId?: string;
    documentCount?: number | null;
    // Web of Science
    researcherId?: string;
    recentWorks?: { title: string | null; year: number | null }[];
    profileUrl: string;
  };
  alreadyAssigned: { identityId: string; professorId: string; sameProfessor: boolean; isActive: boolean } | null;
  previewToken: string;
  previewExpiresAt: string;
}

/* Publications (/api/admin/publications) */
export interface PublicationSummary {
  id: string;
  title: string;
  year: number | null;
  venue: string | null;
  typeFamily: TypeFamily;
  authorNamesDisplay: string | null;
  doi: string | null;
  status: PublicationStatus;
  isCurated: boolean;
  createdAt: string;
  updatedAt: string;
  sources: Source[];
  sourceRecordCount: number;
  relationshipCounts: { pending: number; approved: number; rejected: number };
}
export interface SourceRecordSummary {
  id: string;
  source: Source;
  externalId: string;
  title: string;
  doi: string | null;
  year: number | null;
  venue: string | null;
  typeFamily: TypeFamily;
  authorNamesDisplay: string | null;
  matchMethod: "DOI" | "TITLE_YEAR" | "NEW_PUBLICATION" | "ADMIN";
  matchDetail: string | null;
  /** MANUAL records only: declared basis and evidence (null for imported records). */
  entryBasis: Basis | null;
  entryEvidence: string | null;
  firstSeenAt: string;
  lastSeenAt: string | null;
}
export interface PublicationDetail extends PublicationSummary {
  curation: Curation;
  sourceRecords: SourceRecordSummary[];
  scopusCitation: ScopusCitation | null;
  relationships: {
    id: string;
    status: VerificationStatus;
    origin: "DISCOVERED" | "MANUAL" | "ADMIN";
    decidedAt: string | null;
    createdAt: string;
    professor: { id: string; name: string; isActive: boolean };
    discoveredViaIdentity: { id: string; source: IdentitySource; externalId: string } | null;
  }[];
  duplicateCandidates: {
    id: string;
    reason: string;
    status: CandidateStatus;
    resolvedAt: string | null;
    createdAt: string;
    otherPublication: { id: string; title: string; year: number | null; typeFamily: TypeFamily; doi: string | null; status: PublicationStatus } | null;
  }[];
}
export interface Paged {
  total: number;
  limit: number;
  offset: number;
}
export interface Candidate {
  id: string;
  reason: string;
  status: CandidateStatus;
  resolvedAt: string | null;
  createdAt: string;
  publicationA: PublicationSummary | null;
  publicationB: PublicationSummary | null;
}

/* Synchronization (/api/admin/sync) */
export interface SyncRun {
  id: string;
  trigger: "MANUAL" | "SCHEDULED";
  triggeredByUserId: string | null;
  status: SyncRunStatus;
  tasksTotal: number;
  tasksSucceeded: number;
  tasksFailed: number;
  recordsFetched: number;
  recordsNew: number;
  recordsUpdated: number;
  linksCreated: number;
  candidatesCreated: number;
  startedAt: string;
  finishedAt: string | null;
}
export interface SyncTask {
  id: string;
  source: IdentitySource;
  status: SyncTaskStatus;
  recordsFetched: number;
  recordsNew: number;
  recordsUpdated: number;
  linksCreated: number;
  candidatesCreated: number;
  warnings: number;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  identity: { id: string; externalId: string; professor: { id: string; name: string } } | null;
}
/** Configuration state of a provider: credentials present or not — never whether access works (§13.9). */
export type CredentialState = "NOT_REQUIRED" | "PRESENT" | "NOT_CONFIGURED" | "INCOMPLETE";
export interface ProviderStatus {
  provider: IdentitySource | "JCR";
  label: string;
  purpose: "PUBLICATION_DISCOVERY" | "JOURNAL_METRICS";
  credentials: CredentialState;
  issue: string | null;
}
/** The Clarivate ingestion gate (§22.6): while closed, no Web of Science or JCR request is made. */
export interface ClarivateGateStatus {
  open: boolean;
  message: string | null;
}
export interface ProviderStatusResponse {
  providers: ProviderStatus[];
  clarivateGate: ClarivateGateStatus;
}
/** One discovery provider's coverage in a run, from the snapshot stored at its start (#117, #129, #130). */
export interface ProviderCoverage {
  provider: IdentitySource;
  credentials: CredentialState;
  available: boolean;
  /** Credentials were present, but the Clarivate gate kept the provider from running (§22.6). */
  blocked: boolean;
  identities: number;
  succeeded: number;
  failed: number;
  notConfigured: number;
  blockedTasks: number;
  unfinished: number;
  accessConfirmed: boolean;
  complete: boolean;
}
/* Journal metrics (JCR) runs (/api/admin/sync/journal-metrics) — status and counters only. */
export interface JournalMetricsRun {
  id: string;
  trigger: "MANUAL" | "SCHEDULED";
  triggeredByUserId: string | null;
  status: SyncRunStatus;
  tasksTotal: number;
  tasksSucceeded: number;
  tasksFailed: number;
  journalsChecked: number;
  snapshotsAdded: number;
  jcrDataUpdate: string | null;
  startedAt: string;
  finishedAt: string | null;
}
export interface JournalMetricsTask {
  id: string;
  status: SyncTaskStatus;
  recordsFetched: number;
  snapshotsAdded: number;
  warnings: number;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  journal: { id: string; jcrId: string; name: string } | null;
}

/* Analytics (/api/admin/analytics) */
export interface RunSummary {
  id: string;
  trigger: "MANUAL" | "SCHEDULED";
  status: SyncRunStatus;
  startedAt: string;
  finishedAt: string | null;
}
export interface Overview {
  professors: { total: number; active: number };
  uniquePublications: number;
  uniquePublicationsByType: { typeFamily: TypeFamily; publications: number }[];
  pendingVerifications: number;
  lastSync: RunSummary | null;
  syncRunning: boolean;
}
export interface PerProfessor {
  professors: { id: string; name: string; department: string | null; designation: string | null; isActive: boolean; approvedPublications: number }[];
}
export interface ByYear {
  years: { year: number; publications: number }[];
  unknownYear: number;
  total: number;
}
export interface SourceStats {
  counted: { sources: { source: Source; sourceRecords: number; publications: number }[]; sourceRecords: number; uniquePublications: number };
  stored: { sources: { source: Source; sourceRecords: number }[]; sourceRecords: number; publications: number };
}
export interface SyncStats {
  runs: { total: number; success: number; partialSuccess: number; failed: number; running: number };
  tasks: { success: number; failed: number };
  records: { fetched: number; added: number; updated: number; linksCreated: number; candidatesCreated: number };
  lastRun: RunSummary | null;
  lastSuccessfulRun: RunSummary | null;
}
/** Internal Scopus citation aggregates (§16, #112); Web of Science and JCR figures are not provided. */
export interface CitationStats {
  scopus: {
    countedPublications: number;
    publicationsWithCount: number;
    totalCitations: number;
    latestObservation: string | null;
    professors: { id: string; name: string; isActive: boolean; publicationsWithCount: number; citations: number }[];
  };
}
