/**
 * Backfill retention fields on Firestore docs written before the TTL tranche.
 *
 * Docs created before retention fields were added on write lack the field the
 * TTL policy (`infra/firestore.ttls.json`) targets, so they would never be
 * TTL-deleted:
 *   - `response_context` → `expiresAt` = createdAt + RESPONSE_CONTEXT_RETENTION_DAYS
 *   - `escalation_state` → `retainUntil` = createdAt + 90d
 *
 * Firestore cannot query for field *absence*, so this scans each collection in
 * `__name__` order (300/page) and filters locally. Dry-run is the DEFAULT —
 * nothing is written without `--apply`.
 *
 * Set RESPONSE_CONTEXT_RETENTION_DAYS in your shell to match the deployed
 * service's value, or backfilled deadlines will diverge from new writes.
 *
 * Usage:
 *   npx tsx scripts/backfill-retention-fields.ts --project <id> [--apply]
 */
import { fileURLToPath } from 'node:url';
import type { Firestore, QueryDocumentSnapshot } from '@google-cloud/firestore';
import { initFirestore, getDb } from '../src/state/firestore.js';

// Mirrors the private RETENTION_DAYS IIFE in src/state/responseContext.ts —
// keep the env handling identical so backfilled values match values written
// going forward.
const RESPONSE_CONTEXT_RETENTION_DAYS = (() => {
  const v = Number(process.env.RESPONSE_CONTEXT_RETENTION_DAYS);
  return Number.isFinite(v) && v > 0 ? v : 90;
})();

// Mirrors the private RETAIN_DAYS constant in src/state/escalationState.ts.
const ESCALATION_RETAIN_DAYS = 90;

const PAGE_SIZE = 300; // < Firestore WriteBatch limit (500), so one batch per page is safe

interface Target {
  collection: string;
  field: string;
  retentionDays: number;
}

const TARGETS: Target[] = [
  { collection: 'response_context', field: 'expiresAt', retentionDays: RESPONSE_CONTEXT_RETENTION_DAYS },
  { collection: 'escalation_state', field: 'retainUntil', retentionDays: ESCALATION_RETAIN_DAYS },
];

interface Counts {
  scanned: number;
  missingField: number;
  wouldUpdate: number;
  skippedNoCreatedAt: number;
  updated: number;
}

type FirestoreTimestamp = { toDate: () => Date };

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as FirestoreTimestamp).toDate === 'function'
  ) {
    return (value as FirestoreTimestamp).toDate();
  }
  return undefined;
}

export async function backfillCollection(
  db: Firestore,
  target: Target,
  apply: boolean,
): Promise<Counts> {
  const counts: Counts = {
    scanned: 0,
    missingField: 0,
    wouldUpdate: 0,
    skippedNoCreatedAt: 0,
    updated: 0,
  };

  let lastDoc: QueryDocumentSnapshot | undefined;
  for (;;) {
    let query = db
      .collection(target.collection)
      .orderBy('__name__')
      .limit(PAGE_SIZE);
    if (lastDoc) query = query.startAfter(lastDoc);

    const snapshot = await query.get();
    if (snapshot.empty) break;

    const batch = db.batch();
    let batchOps = 0;

    for (const doc of snapshot.docs) {
      counts.scanned++;
      const data = doc.data();
      if (data[target.field] !== undefined) continue;
      counts.missingField++;

      const createdAt = toDate(data.createdAt);
      if (!createdAt) {
        // Very old or malformed doc — don't fabricate a retention deadline.
        counts.skippedNoCreatedAt++;
        continue;
      }

      counts.wouldUpdate++;
      if (apply) {
        batch.update(doc.ref, {
          [target.field]: new Date(
            createdAt.getTime() + target.retentionDays * 86_400_000,
          ),
        });
        batchOps++;
      }
    }

    if (batchOps > 0) {
      await batch.commit();
      counts.updated += batchOps;
    }

    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < PAGE_SIZE) break;
  }

  return counts;
}

function usage(): void {
  console.error(
    'Usage: npx tsx scripts/backfill-retention-fields.ts --project <id> [--apply]\n' +
    '  --project <id>  GCP project ID (required)\n' +
    '  --apply         Perform updates. Without it, dry-run: print counts only.',
  );
}

function parseArgs(argv: string[]): { projectId: string; apply: boolean } | null {
  let projectId: string | undefined;
  let apply = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project') {
      projectId = argv[++i];
      if (!projectId || projectId.startsWith('--')) {
        console.error('--project requires a value');
        return null;
      }
    } else if (arg === '--apply') {
      apply = true;
    } else {
      console.error(`Unknown argument: ${arg}`);
      return null;
    }
  }

  if (!projectId) {
    console.error('--project <id> is required');
    return null;
  }
  return { projectId, apply };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    usage();
    process.exit(1);
  }

  initFirestore(args.projectId);
  const db = getDb();

  console.log(
    `${args.apply ? 'APPLY' : 'DRY RUN'} — project ${args.projectId} ` +
    `(response_context retention: ${RESPONSE_CONTEXT_RETENTION_DAYS}d, ` +
    `escalation_state retention: ${ESCALATION_RETAIN_DAYS}d)\n`,
  );

  for (const target of TARGETS) {
    const counts = await backfillCollection(db, target, args.apply);
    console.log(`${target.collection} (${target.field}):`);
    console.log(`  scanned:             ${counts.scanned}`);
    console.log(`  missing field:       ${counts.missingField}`);
    console.log(`  would update:        ${counts.wouldUpdate}`);
    console.log(`  skipped (no createdAt): ${counts.skippedNoCreatedAt}`);
    if (args.apply) {
      console.log(`  updated:             ${counts.updated}`);
    }
    console.log('');
  }

  if (!args.apply) {
    console.log('Dry run — nothing was written. Re-run with --apply to perform updates.');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
