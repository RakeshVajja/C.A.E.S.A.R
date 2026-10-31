/**
 * The Clarivate ingestion gate (Project_plan.md §13.10, §22.6; decisions #121, #124; `CLAUDE.md`):
 * no live Web of Science or Journal Citation Reports data may be requested or ingested before BOTH
 *   1. the provider-data removal tool (stage 15.8) is complete, and
 *   2. Clarivate's written confirmations on retention, deletion, backups and display are on record.
 *
 * Both conditions are fixed in code and both are false in this version, so the gate is closed
 * whatever the environment holds: present Clarivate credentials do not open it, and there is no
 * environment switch (§22.1: no `*_ENABLED` switches). Opening it is a reviewed code change made
 * only when both conditions are actually met and the owner has approved it.
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

/** The gate of this version: closed. */
export const CLARIVATE_GATE: ClarivateGate = Object.freeze({ removalToolingComplete: false, writtenConfirmationsOnRecord: false });

export function isClarivateGateOpen(gate: ClarivateGate = CLARIVATE_GATE): boolean {
  return gate.removalToolingComplete === true && gate.writtenConfirmationsOnRecord === true;
}

/** Why live Clarivate requests are blocked (fixed text; shown to the administrator and stored on tasks). */
export const CLARIVATE_GATE_MESSAGE =
  'Live Clarivate data (Web of Science, Journal Citation Reports) is blocked until the provider-data removal tool (stage 15.8) is ' +
  "complete and Clarivate's written confirmations on retention, deletion, backups and display are on record";
