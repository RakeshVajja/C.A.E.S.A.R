/**
 * The Clarivate ingestion gate (Project_plan.md §13.10, §22.6; decisions #121, #124; `CLAUDE.md`):
 * no live Web of Science or Journal Citation Reports data may be requested or ingested before BOTH
 *   1. the provider-data removal tool (stage 15.8) is complete, and
 *   2. Clarivate's written confirmations on retention, deletion, backups and display are on record.
 *
 * Both conditions are fixed in code. Condition 1 is met: stage 15.8 is committed and pushed
 * (35c0210) and the owner recorded it as complete (#148). Condition 2 is not: no written Clarivate
 * confirmation is on record, so the gate stays closed whatever the environment holds — present
 * Clarivate credentials do not open it, and there is no environment switch (§22.1: no `*_ENABLED`
 * switches). Setting condition 2 is a reviewed code change made only when the confirmations
 * actually exist and the owner has approved it.
 *
 * It is enforced in the backend at every level: the Web of Science and JCR clients refuse to send
 * any request while it is closed, the synchronization engine never plans WoS discovery or starts a
 * JCR run (admin, schedule or after-discovery), and the WoS identity preview is refused. Tests open
 * a gate explicitly, with synthetic responses only.
 */

export interface ClarivateGate {
  /** Stage 15.8 (provider-data removal: dry run, fingerprinted approval, transactional removal) is complete. */
  readonly removalToolingComplete: boolean;
  /** Clarivate's written confirmations (retention, deletion, backups, display) are on record. */
  readonly writtenConfirmationsOnRecord: boolean;
}

/** The gate of this version: closed — removal tooling complete (#148), written confirmations not on record. */
export const CLARIVATE_GATE: ClarivateGate = Object.freeze({ removalToolingComplete: true, writtenConfirmationsOnRecord: false });

export function isClarivateGateOpen(gate: ClarivateGate = CLARIVATE_GATE): boolean {
  return gate.removalToolingComplete === true && gate.writtenConfirmationsOnRecord === true;
}

/** Why live Clarivate requests are blocked (fixed text; shown to the administrator and stored on tasks). */
export const CLARIVATE_GATE_MESSAGE =
  "Live Clarivate data (Web of Science, Journal Citation Reports) is blocked until Clarivate's written confirmations on retention, " +
  'deletion, backups and display are on record (the provider-data removal tool, stage 15.8, is complete)';
