# Sanctioned UX-Trust Items Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the three sanctioned UX-trust items — feedback-loop closure to the user, clarification bailout, and a help/onboarding surface — per `docs/superpowers/plans/2026-06-10-ux-trust-items-design.md`.

**Architecture:** Item 1 follows "the CLI originates, the bot delivers": teaching promotion enqueues a `pending_notifications` Firestore doc; the existing scheduler-driven lifecycle sweep posts it to the originating thread. Item 3 adds a `clarification_cancel` Slack action offered on both surfaces where a pending clarification is visible. Item 2 is one pure Block Kit builder feeding a `/anna help` intercept and an App Home tab.

**Tech Stack:** TypeScript (NodeNext ESM — all relative imports end in `.js`), Bolt.js, Firestore (`@google-cloud/firestore` via `src/state/firestore.ts` singleton), Vitest.

**Read first:** the design doc above; CLAUDE.md "Module Dependency Rules" (state/ is a leaf; handlers/ delegate; agents/ never import slack//state/) and "Mocking in Tests".

**Sequencing:** Item 1 (Tasks 1–6) → Item 3 (Tasks 7–9) → Item 2 (Tasks 10–12) → governance + final verification (Task 13). Each task is independently committable.

**Conventions used throughout:**
- Run single test files with `npx vitest run <path>`; full suite is `npm test`; types with `npm run typecheck`.
- Firestore writes must never contain a literal `undefined` value — omit absent optional keys (conditional spread), or `.set()` throws at runtime.
- Block Kit arrays passed to Slack client calls are cast `as unknown as KnownBlock[]` (existing idiom, see `src/handlers/feedbackEscalation.ts`).
- **Parity convention:** *implementation* code blocks and fragments in this plan are kept byte-identical to (or verbatim-contained in) the shipped source and test files, amended in the same change set as any review-driven fix. Step-1 "failing test" prescriptions are starting points, not parity surfaces — the shipped tests supersede them.

---

## Item 1 — Close the feedback loop to the user

### Task 1: `pending_notifications` state module

**Files:**
- Create: `src/state/pendingNotifications.ts`
- Test: `tests/state/pendingNotifications.test.ts`

**Step 1: Write the failing test**

Model the Firestore mock on `tests/state/feedbackNotes.test.ts` (chainable fn mocks + `vi.mock` of the firestore singleton):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSet = vi.fn();
const mockGet = vi.fn();
const mockUpdate = vi.fn();
const mockWhere = vi.fn(() => ({ get: mockGet }));
const mockDoc = vi.fn(() => ({ set: mockSet, update: mockUpdate }));
const mockCollection = vi.fn(() => ({ doc: mockDoc, where: mockWhere }));

vi.mock('../../src/state/firestore.js', () => ({
  getDb: vi.fn(() => ({ collection: mockCollection })),
}));

import {
  enqueueNotification,
  getPendingNotifications,
  markNotificationDelivered,
} from '../../src/state/pendingNotifications.js';

describe('pendingNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWhere.mockReturnValue({ get: mockGet });
    mockDoc.mockReturnValue({ set: mockSet, update: mockUpdate });
    mockCollection.mockReturnValue({ doc: mockDoc, where: mockWhere });
    mockSet.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue(undefined);
  });

  it('enqueues with status pending and a ~30d expiresAt', async () => {
    await enqueueNotification({
      id: 'notif_teach_esc_fb_tr1',
      kind: 'teaching_promoted',
      channel: 'C1',
      threadTs: '1718000000.000100',
      userId: 'U1',
      teachingId: 'teach_esc_fb_tr1',
    });

    expect(mockCollection).toHaveBeenCalledWith('pending_notifications');
    expect(mockDoc).toHaveBeenCalledWith('notif_teach_esc_fb_tr1');
    const written = mockSet.mock.calls[0][0];
    expect(written.status).toBe('pending');
    expect(written.userId).toBe('U1');
    const ageMs = written.expiresAt.getTime() - written.createdAt.getTime();
    expect(ageMs).toBe(30 * 86_400_000);
  });

  it('omits userId entirely when absent (Firestore rejects undefined)', async () => {
    await enqueueNotification({
      id: 'notif_teach_esc_a',
      kind: 'teaching_promoted',
      channel: 'C1',
      threadTs: '1718000000.000100',
      teachingId: 'teach_esc_a',
    });
    expect(mockSet.mock.calls[0][0]).not.toHaveProperty('userId');
  });

  it('getPendingNotifications filters on status only (no orderBy)', async () => {
    mockGet.mockResolvedValue({
      empty: false,
      docs: [
        {
          data: () => ({
            id: 'notif_x',
            kind: 'teaching_promoted',
            channel: 'C1',
            threadTs: 't1',
            teachingId: 'teach_x',
            status: 'pending',
            createdAt: { toDate: () => new Date('2026-06-10T00:00:00Z') },
            expiresAt: { toDate: () => new Date('2026-07-10T00:00:00Z') },
          }),
        },
      ],
    });

    const result = await getPendingNotifications();

    expect(mockWhere).toHaveBeenCalledWith('status', '==', 'pending');
    expect(result).toHaveLength(1);
    expect(result[0].createdAt).toBeInstanceOf(Date);
  });

  it('getPendingNotifications returns [] when empty', async () => {
    mockGet.mockResolvedValue({ empty: true, docs: [] });
    expect(await getPendingNotifications()).toEqual([]);
  });

  it('markNotificationDelivered flips status', async () => {
    await markNotificationDelivered('notif_x');
    expect(mockDoc).toHaveBeenCalledWith('notif_x');
    expect(mockUpdate).toHaveBeenCalledWith({ status: 'delivered' });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/state/pendingNotifications.test.ts`
Expected: FAIL — cannot resolve `src/state/pendingNotifications.js`.

**Step 3: Write the implementation**

`src/state/pendingNotifications.ts` (leaf module — imports only `./firestore.js`):

```typescript
import { getDb } from './firestore.js';

const COLLECTION = 'pending_notifications';
const RETENTION_DAYS = 30;

export interface PendingNotification {
  /** notif_<candidateId> — idempotent across re-approval of the same candidate. */
  id: string;
  kind: 'teaching_promoted';
  channel: string;
  threadTs: string;
  /** The feedback reporter to @-mention; absent for escalation-originated teachings. */
  userId?: string;
  teachingId: string;
  status: 'pending' | 'delivered';
  createdAt: Date;
  expiresAt: Date;
}

export type NotificationInput = Omit<PendingNotification, 'status' | 'createdAt' | 'expiresAt'>;

export async function enqueueNotification(input: NotificationInput): Promise<void> {
  const now = new Date();
  await getDb().collection(COLLECTION).doc(input.id).set({
    ...input,
    status: 'pending',
    createdAt: now,
    expiresAt: new Date(now.getTime() + RETENTION_DAYS * 86_400_000),
  });
}

type FirestoreTimestamp = { toDate: () => Date };

function toDate(value: Date | FirestoreTimestamp): Date {
  return value instanceof Date ? value : value.toDate();
}

/** Status-only filter — no orderBy, so no composite index (delivery order is irrelevant). */
export async function getPendingNotifications(): Promise<PendingNotification[]> {
  const snapshot = await getDb()
    .collection(COLLECTION)
    .where('status', '==', 'pending')
    .get();

  if (snapshot.empty) return [];

  return snapshot.docs.map((doc) => {
    const data = doc.data() as Record<string, unknown>;
    return {
      ...data,
      createdAt: toDate(data.createdAt as Date | FirestoreTimestamp),
      expiresAt: toDate(data.expiresAt as Date | FirestoreTimestamp),
    } as PendingNotification;
  });
}

export async function markNotificationDelivered(id: string): Promise<void> {
  await getDb().collection(COLLECTION).doc(id).update({ status: 'delivered' });
}
```

Note the contract: callers must OMIT `userId` rather than pass `undefined` (the spread preserves whatever keys the caller built — see Task 4's conditional spread).

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/state/pendingNotifications.test.ts`
Expected: 5 passed.

**Step 5: Commit**

```bash
git add src/state/pendingNotifications.ts tests/state/pendingNotifications.test.ts
git commit -m "feat: add pending_notifications state module"
```

---

### Task 2: `getEscalationById` provenance lookup

**Files:**
- Modify: `src/state/escalationState.ts` (append after `getEscalationByEscalationThread`, ~line 80)
- Test: `tests/state/escalationState.test.ts` (extend)

**Step 1: Write the failing test**

Append to the existing describe in `tests/state/escalationState.test.ts`, reusing that file's existing Firestore mock chain (it already mocks `doc()`; if its `mockDoc` return lacks `get`, add `get: mockDocGet` to the returned object and a `const mockDocGet = vi.fn()` at the top, resetting it in `beforeEach` like the others):

```typescript
describe('getEscalationById', () => {
  it('returns the mapped state for an existing doc regardless of pipelineState', async () => {
    mockDocGet.mockResolvedValue({
      exists: true,
      data: () => ({
        escalationId: 'esc_fb_tr1',
        originalThreadTs: '1718000000.000100',
        originalChannel: 'C0RIGIN',
        pipelineState: 'resolved',
        context: { feedbackUserId: 'U1' },
        createdAt: { toDate: () => new Date('2026-06-01T00:00:00Z') },
        expiresAt: { toDate: () => new Date('2026-06-01T04:00:00Z') },
      }),
    });

    const state = await getEscalationById('esc_fb_tr1');

    expect(state?.originalChannel).toBe('C0RIGIN');
    expect(state?.context.feedbackUserId).toBe('U1');
    expect(state?.createdAt).toBeInstanceOf(Date);
  });

  it('returns null when the doc does not exist', async () => {
    mockDocGet.mockResolvedValue({ exists: false });
    expect(await getEscalationById('esc_gone')).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/state/escalationState.test.ts`
Expected: FAIL — `getEscalationById` is not exported.

**Step 3: Write the implementation**

In `src/state/escalationState.ts`:

```typescript
/**
 * Direct lookup by escalationId (the doc key) for provenance chains — e.g.
 * teaching promotion recovering the originating thread. Deliberately ignores
 * pipelineState and expiry: promoted candidates come from RESOLVED escalations.
 */
export async function getEscalationById(
  escalationId: string,
): Promise<EscalationState | null> {
  const doc = await getDb().collection(COLLECTION).doc(escalationId).get();
  if (!doc.exists) return null;
  return toEscalationState(doc.data() as Record<string, unknown>);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/state/escalationState.test.ts`
Expected: all pass (existing + 2 new).

**Step 5: Commit**

```bash
git add src/state/escalationState.ts tests/state/escalationState.test.ts
git commit -m "feat: add getEscalationById provenance lookup"
```

---

### Task 3: TTL manifest + docs row for the new collection

**Files:**
- Modify: `tests/infra/firestoreTtls.test.ts` (the pinned `expected` array)
- Modify: `infra/firestore.ttls.json`
- Modify: `CLAUDE.md` (Firestore Collections table)
- Modify: `README.md` (Firestore TTL Policy section)

**Step 1: Extend the parity test first**

In `tests/infra/firestoreTtls.test.ts`, append to the `expected` array:

```typescript
      { collectionGroup: 'pending_notifications', field: 'expiresAt' },
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/infra/firestoreTtls.test.ts`
Expected: FAIL — manifest missing the new entry.

**Step 3: Update manifest + docs**

`infra/firestore.ttls.json` — append to `ttls`:

```json
    { "collectionGroup": "pending_notifications", "field": "expiresAt" }
```

`CLAUDE.md` — add a row to the Firestore Collections table:

```markdown
| `pending_notifications` | `notif_<candidateId>` | User-facing notifications enqueued by `scripts/promote-teachings.ts`, delivered by the lifecycle sweep; `expiresAt` TTL (30d) |
```

`README.md` — in the "Firestore TTL Policy" section, the apply command list gains the new collection (mirror the existing per-collection `gcloud firestore fields ttls update expiresAt --collection-group=<name> --enable-ttl` line/loop — match however the section enumerates collections). Add a sentence: applying this TTL in an existing install is a manual operator step.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/infra/firestoreTtls.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add infra/firestore.ttls.json tests/infra/firestoreTtls.test.ts CLAUDE.md README.md
git commit -m "chore: declare pending_notifications TTL policy"
```

---

### Task 4: enqueue notification on approval in `promote-teachings`

**Files:**
- Modify: `scripts/promote-teachings.ts`
- Test: `tests/scripts/promote-teachings.test.ts` (extend)

**Step 1: Write the failing tests**

In `tests/scripts/promote-teachings.test.ts`, add two module mocks next to the existing `vi.mock` blocks, import the mocked fns, and add a fixture helper:

```typescript
vi.mock('../../src/state/escalationState.js', () => ({
  getEscalationById: vi.fn(),
}));

vi.mock('../../src/state/pendingNotifications.js', () => ({
  enqueueNotification: vi.fn(),
}));

import { getEscalationById } from '../../src/state/escalationState.js';
import { enqueueNotification } from '../../src/state/pendingNotifications.js';

function makeEscalation(overrides: Record<string, unknown> = {}) {
  return {
    escalationId: 'esc_abc123',
    originalThreadTs: '1718000000.000100',
    originalChannel: 'C0RIGIN',
    context: { feedbackUserId: 'U0FEEDBACK' },
    ...overrides,
  } as unknown as import('../../src/types.js').EscalationState;
}
```

New describe block (set `vi.mocked(getEscalationById).mockResolvedValue(makeEscalation())` etc. per case; remember `vi.clearAllMocks()` in the shared `beforeEach` wipes return values — set them inside each test):

```typescript
describe('promotion notification enqueue', () => {
  it('enqueues with the origin thread and the feedback user on approve', async () => {
    vi.mocked(getEscalationById).mockResolvedValue(makeEscalation());
    await runPromotion(createMockRl(['a']), [makeCandidate()]);

    expect(getEscalationById).toHaveBeenCalledWith('esc_abc123');
    expect(enqueueNotification).toHaveBeenCalledWith({
      id: 'notif_teach_esc_abc123',
      kind: 'teaching_promoted',
      channel: 'C0RIGIN',
      threadTs: '1718000000.000100',
      userId: 'U0FEEDBACK',
      teachingId: 'teach_esc_abc123',
    });
  });

  it('omits userId when the escalation has no feedbackUserId', async () => {
    vi.mocked(getEscalationById).mockResolvedValue(makeEscalation({ context: {} }));
    await runPromotion(createMockRl(['a']), [makeCandidate()]);
    expect(vi.mocked(enqueueNotification).mock.calls[0][0]).not.toHaveProperty('userId');
  });

  it('skips silently when the origin escalation is gone (past retention)', async () => {
    vi.mocked(getEscalationById).mockResolvedValue(null);
    const counts = await runPromotion(createMockRl(['a']), [makeCandidate()]);
    expect(enqueueNotification).not.toHaveBeenCalled();
    expect(counts.approved).toBe(1);
  });

  it('does not fail the promotion when enqueue throws', async () => {
    vi.mocked(getEscalationById).mockResolvedValue(makeEscalation());
    vi.mocked(enqueueNotification).mockRejectedValue(new Error('firestore down'));
    const counts = await runPromotion(createMockRl(['a']), [makeCandidate()]);
    expect(counts.approved).toBe(1);
  });

  it('does not look up provenance on reject', async () => {
    await runPromotion(createMockRl(['r']), [makeCandidate()]);
    expect(getEscalationById).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scripts/promote-teachings.test.ts`
Expected: new tests FAIL (no enqueue happens); existing tests still pass.

**Step 3: Write the implementation**

In `scripts/promote-teachings.ts`:

Add imports:

```typescript
import { getEscalationById } from '../src/state/escalationState.js';
import { enqueueNotification } from '../src/state/pendingNotifications.js';
```

Add the helper above `runPromotion`:

```typescript
/**
 * Best-effort: closing the feedback loop must never block or fail a promotion.
 * The escalation doc (keyed by escalationId, 90d retainUntil) recovers the
 * originating thread; past retention there is simply no one left to notify.
 */
async function enqueuePromotionNotification(candidate: TeachingCandidate): Promise<void> {
  try {
    const escalation = await getEscalationById(candidate.escalationId);
    if (!escalation) {
      console.log('  (origin escalation not found — no user notification queued)');
      return;
    }
    await enqueueNotification({
      id: `notif_${candidate.candidateId}`,
      kind: 'teaching_promoted',
      channel: escalation.originalChannel,
      threadTs: escalation.originalThreadTs,
      ...(escalation.context.feedbackUserId
        ? { userId: escalation.context.feedbackUserId }
        : {}),
      teachingId: candidate.candidateId,
    });
    console.log('  -> User notification queued (delivered by the next lifecycle sweep).');
  } catch (err) {
    console.warn(`  (could not queue user notification: ${(err as Error).message})`);
  }
}
```

In the approve branch of `runPromotion`, after `await updateCandidateStatus(candidate.candidateId, 'approved');`:

```typescript
      await enqueuePromotionNotification(candidate);
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/scripts/promote-teachings.test.ts`
Expected: all pass.

**Step 5: Commit**

```bash
git add scripts/promote-teachings.ts tests/scripts/promote-teachings.test.ts
git commit -m "feat: enqueue user notification on teaching promotion"
```

---

### Task 5: delivery handler

**Files:**
- Create: `src/handlers/notificationDelivery.ts`
- Test: `tests/handlers/notificationDelivery.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebClient } from '@slack/web-api';

vi.mock('../../src/state/pendingNotifications.js', () => ({
  getPendingNotifications: vi.fn(),
  markNotificationDelivered: vi.fn(),
}));

import {
  getPendingNotifications,
  markNotificationDelivered,
} from '../../src/state/pendingNotifications.js';
import { deliverPendingNotifications } from '../../src/handlers/notificationDelivery.js';

const mockPostMessage = vi.fn();
const mockClient = { chat: { postMessage: mockPostMessage } } as unknown as WebClient;

function makeNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: 'notif_teach_1',
    kind: 'teaching_promoted' as const,
    channel: 'C1',
    threadTs: '1718000000.000100',
    userId: 'U1',
    teachingId: 'teach_1',
    status: 'pending' as const,
    createdAt: new Date(),
    expiresAt: new Date(),
    ...overrides,
  };
}

describe('deliverPendingNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPostMessage.mockResolvedValue({ ok: true });
    vi.mocked(markNotificationDelivered).mockResolvedValue(undefined);
  });

  it('posts to the originating thread, mentions the user, and marks delivered', async () => {
    vi.mocked(getPendingNotifications).mockResolvedValue([makeNotification()]);

    const result = await deliverPendingNotifications(mockClient);

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1',
        thread_ts: '1718000000.000100',
        text: expect.stringContaining('<@U1>'),
      }),
    );
    expect(markNotificationDelivered).toHaveBeenCalledWith('notif_teach_1');
    expect(result).toEqual({ delivered: 1, failed: 0 });
  });

  it('uses the no-mention copy when userId is absent', async () => {
    const n = makeNotification();
    delete (n as Record<string, unknown>).userId;
    vi.mocked(getPendingNotifications).mockResolvedValue([n]);

    await deliverPendingNotifications(mockClient);

    const text = mockPostMessage.mock.calls[0][0].text as string;
    expect(text).not.toContain('<@');
    expect(text).toContain('part of my knowledge');
  });

  it('leaves the doc pending when the Slack post fails', async () => {
    vi.mocked(getPendingNotifications).mockResolvedValue([makeNotification()]);
    mockPostMessage.mockRejectedValue(new Error('rate_limited'));

    const result = await deliverPendingNotifications(mockClient);

    expect(markNotificationDelivered).not.toHaveBeenCalled();
    expect(result).toEqual({ delivered: 0, failed: 1 });
  });

  it('continues past a failure to deliver the rest', async () => {
    vi.mocked(getPendingNotifications).mockResolvedValue([
      makeNotification({ id: 'notif_a' }),
      makeNotification({ id: 'notif_b' }),
    ]);
    mockPostMessage
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ok: true });

    const result = await deliverPendingNotifications(mockClient);

    expect(markNotificationDelivered).toHaveBeenCalledTimes(1);
    expect(markNotificationDelivered).toHaveBeenCalledWith('notif_b');
    expect(result).toEqual({ delivered: 1, failed: 1 });
  });

  it('no-ops on an empty queue', async () => {
    vi.mocked(getPendingNotifications).mockResolvedValue([]);
    const result = await deliverPendingNotifications(mockClient);
    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ delivered: 0, failed: 0 });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/handlers/notificationDelivery.test.ts`
Expected: FAIL — module does not exist.

**Step 3: Write the implementation**

`src/handlers/notificationDelivery.ts`:

```typescript
import type { WebClient } from '@slack/web-api';
import {
  getPendingNotifications,
  markNotificationDelivered,
  type PendingNotification,
} from '../state/pendingNotifications.js';

function notificationText(n: PendingNotification): string {
  return n.userId
    ? `✅ <@${n.userId}> your feedback on this answer was reviewed by the data team and is now part of my knowledge. Future answers to questions like this will use it.`
    : '✅ An update from the data team: the guidance from this thread is now part of my knowledge. Future answers to questions like this will use it.';
}

/**
 * Drains the pending_notifications queue: posts each to its originating thread,
 * marking delivered only after the post succeeds. A failed post leaves the doc
 * pending for the next sweep — at-least-once delivery, deduplicated by the
 * idempotent notif_<candidateId> doc id at enqueue time.
 */
export async function deliverPendingNotifications(
  client: WebClient,
): Promise<{ delivered: number; failed: number }> {
  const pending = await getPendingNotifications();
  const result = { delivered: 0, failed: 0 };

  for (const notification of pending) {
    try {
      await client.chat.postMessage({
        channel: notification.channel,
        thread_ts: notification.threadTs,
        text: notificationText(notification),
      });
      await markNotificationDelivered(notification.id);
      result.delivered += 1;
    } catch (err) {
      console.error(`Notification delivery failed for ${notification.id}:`, (err as Error).message);
      result.failed += 1;
    }
  }

  return result;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/handlers/notificationDelivery.test.ts`
Expected: 5 passed.

**Step 5: Commit**

```bash
git add src/handlers/notificationDelivery.ts tests/handlers/notificationDelivery.test.ts
git commit -m "feat: add promotion-notification delivery handler"
```

---

### Task 6: wire delivery into the lifecycle sweep

**Files:**
- Modify: `src/handlers/lifecycleSweep.ts`
- Modify: `CLAUDE.md` (REST Endpoints table — lifecycle-sweep purpose; Escalation section sentence)
- Test: `tests/handlers/lifecycleSweep.test.ts` (extend)

**Step 1: Write the failing test**

In `tests/handlers/lifecycleSweep.test.ts`, add next to the existing escalationLifecycle mock:

```typescript
vi.mock('../../src/handlers/notificationDelivery.js', () => ({
  deliverPendingNotifications: vi.fn(),
}));

import { deliverPendingNotifications } from '../../src/handlers/notificationDelivery.js';
```

In the shared `beforeEach`, default it: `vi.mocked(deliverPendingNotifications).mockResolvedValue({ delivered: 0, failed: 0 });` — this keeps every existing test passing if they assert with `expect.objectContaining` (if any assert exact JSON equality, widen those assertions to include `notificationsDelivered: 0, notificationsFailed: 0`).

New test:

```typescript
  it('delivers pending notifications and merges counts into the response', async () => {
    mockSweep.mockResolvedValue({ throttled: false, pending: 0, reminded: 0, timedOut: 0 });
    vi.mocked(deliverPendingNotifications).mockResolvedValue({ delivered: 2, failed: 1 });
    const { res, json } = buildRes();

    await routeHandler(buildReq(), res);

    expect(deliverPendingNotifications).toHaveBeenCalledWith(mockClient);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ notificationsDelivered: 2, notificationsFailed: 1 }),
    );
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/handlers/lifecycleSweep.test.ts`
Expected: new test FAILS (no notification fields in response).

**Step 3: Write the implementation**

In `src/handlers/lifecycleSweep.ts`, import the handler and extend the success path (delivery is NOT subject to `checkOverdueEscalations`' internal 60s throttle — a throttled sweep still drains the queue):

```typescript
import { deliverPendingNotifications } from './notificationDelivery.js';
```

```typescript
      const result = await checkOverdueEscalations(deps.getClient(), deps.getEscalationConfig());
      const notifications = await deliverPendingNotifications(deps.getClient());
      res.status(200).json({
        ...result,
        notificationsDelivered: notifications.delivered,
        notificationsFailed: notifications.failed,
      });
```

`CLAUDE.md` updates: lifecycle-sweep endpoint purpose becomes "Trigger escalation reminder/timeout sweep + deliver queued user notifications (Cloud Scheduler)"; in the Escalation section, after the sweep sentence, add: "Teaching promotions enqueue `pending_notifications` docs that the sweep delivers to the originating thread (closing the feedback loop to the user)."

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/handlers/lifecycleSweep.test.ts`
Expected: all pass (existing + new).

**Step 5: Commit**

```bash
git add src/handlers/lifecycleSweep.ts tests/handlers/lifecycleSweep.test.ts CLAUDE.md
git commit -m "feat: deliver promotion notifications on the lifecycle sweep"
```

---

## Item 3 — Clarification bailout

### Task 7: cancel button on both clarification surfaces (blocks only)

> **Amended after final review (2026-06-10):** the nudge copy was duplicated between this builder and preflight guard 2's message fallback `text` — it is now exported as `PENDING_CLARIFICATION_TEXT` and shared. The echoed original question is now passed through `escapeMrkdwn` before interpolation: it is user-controlled text, and a stored `<!channel>` would otherwise re-ping the channel when echoed back.

**Files:**
- Modify: `src/slack/clarificationBlocks.ts`
- Test: `tests/slack/clarificationBlocks.test.ts` (extend)

**Step 1: Write the failing tests**

```typescript
  it('includes a cancel button carrying the clarificationId', () => {
    const blocks = buildClarificationBlocks({
      clarificationId: 'clar_1',
      clarifyingQuestions: ['Which date range?'],
      originalQuestion: 'show me sessions',
    });
    const actions = blocks.find((b) => b.type === 'actions') as {
      elements: Array<{ action_id: string; value: string }>;
    };
    expect(actions).toBeDefined();
    expect(actions.elements[0].action_id).toBe('clarification_cancel');
    expect(actions.elements[0].value).toBe('clar_1');
  });

describe('buildPendingClarificationBlocks', () => {
  it('shows the original question and the same cancel action', () => {
    const blocks = buildPendingClarificationBlocks({
      clarificationId: 'clar_1',
      originalQuestion: 'show me sessions',
    });
    expect(JSON.stringify(blocks)).toContain('show me sessions');
    const actions = blocks.find((b) => b.type === 'actions') as {
      elements: Array<{ action_id: string; value: string }>;
    };
    expect(actions.elements[0].action_id).toBe('clarification_cancel');
    expect(actions.elements[0].value).toBe('clar_1');
  });
});
```

(Import `buildPendingClarificationBlocks` alongside the existing import.)

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/slack/clarificationBlocks.test.ts`
Expected: FAIL — no actions block; no such export.

**Step 3: Write the implementation**

In `src/slack/clarificationBlocks.ts` — in `buildClarificationBlocks`, after the context block is pushed:

```typescript
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'Never mind — cancel',
        },
        action_id: 'clarification_cancel',
        value: options.clarificationId,
      },
    ],
  });
```

(Change the destructure to keep `options` available, or reference `options.clarificationId` directly.)

New export in the same file:

```typescript
export interface PendingClarificationBlocksOptions {
  clarificationId: string;
  originalQuestion: string;
}

/** Guard 2's nudge — also the message fallback text in preflightChecks. */
export const PENDING_CLARIFICATION_TEXT =
  "I'm still waiting on your answer to my earlier question — reply to that message and I'll pick it up from there.";

// Slack mrkdwn entity escapes. Without them a stored "<!channel>" in the
// echoed original question would re-ping the channel.
function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Preflight guard 2 block message: the nudge, the question being waited on, and a way out. */
export function buildPendingClarificationBlocks(
  options: PendingClarificationBlocksOptions,
): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: PENDING_CLARIFICATION_TEXT,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Waiting on my question about: _${escapeMrkdwn(options.originalQuestion)}_`,
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Cancel that question',
          },
          action_id: 'clarification_cancel',
          value: options.clarificationId,
        },
      ],
    },
  ];

  return blocks;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/slack/clarificationBlocks.test.ts`
Expected: all pass.

**Step 5: Commit**

```bash
git add src/slack/clarificationBlocks.ts tests/slack/clarificationBlocks.test.ts
git commit -m "feat: offer cancel on clarification surfaces"
```

---

### Task 8: preflight guard 2 posts the bailout blocks

> **Amended after final review (2026-06-10):** the fallback `text` now references the shared `PENDING_CLARIFICATION_TEXT` constant instead of duplicating the nudge copy (see Task 7's note).

**Files:**
- Modify: `src/handlers/preflightChecks.ts:43-53` (guard 2)
- Test: `tests/handlers/preflightChecks.test.ts` (modify)

**Step 1: Update the tests (they will fail first)**

`tests/handlers/preflightChecks.test.ts` currently mocks `hasPendingClarification`. Replace that mock with `getClarificationState` (keep the same mock-fn indirection style the file already uses):

```typescript
vi.mock('../../src/state/clarificationState.js', () => ({
  getClarificationState: (...args: unknown[]) => mockGetClarificationState(...args),
}));
```

Update existing guard-2 tests: where they set `mockHasPendingClarification` to `true`/`false`, return a state object / `null` instead:

```typescript
const pendingState = {
  clarificationId: 'clar_1',
  threadTs: 'T1',
  channel: 'C1',
  originalQuestion: 'show me sessions',
  ambiguities: [],
  clarifyingMessageTs: '123.456',
  state: 'awaiting_reply',
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 60_000),
};
```

Add an assertion to the blocked-by-clarification test:

```typescript
    const postArgs = mockPostMessage.mock.calls[0][0];
    expect(JSON.stringify(postArgs.blocks)).toContain('clarification_cancel');
    expect(JSON.stringify(postArgs.blocks)).toContain('show me sessions');
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/handlers/preflightChecks.test.ts`
Expected: FAIL — preflight still imports `hasPendingClarification`.

**Step 3: Write the implementation**

In `src/handlers/preflightChecks.ts`, swap the import and guard 2 (the lock-release/throw-path structure stays exactly as is):

```typescript
import { getClarificationState } from '../state/clarificationState.js';
import {
  buildPendingClarificationBlocks,
  PENDING_CLARIFICATION_TEXT,
} from '../slack/clarificationBlocks.js';
import type { KnownBlock } from '@slack/types';
```

```typescript
    const pendingClarification = await getClarificationState(threadTs);
    if (pendingClarification) {
      rootLogger.warn({ threadTs }, 'preflight.pending_clarification_block');
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: PENDING_CLARIFICATION_TEXT,
        blocks: buildPendingClarificationBlocks({
          clarificationId: pendingClarification.clarificationId,
          originalQuestion: pendingClarification.originalQuestion,
        }) as unknown as KnownBlock[],
      });
      await releaseThreadLock(threadTs);
      return false;
    }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/handlers/preflightChecks.test.ts`
Expected: all pass. Also run `npx vitest run tests/integration/messageHandler.integration.test.ts` — the integration harness mocks state modules; if it mocked `hasPendingClarification`, update that mock to `getClarificationState` returning `null`.

**Step 5: Commit**

```bash
git add src/handlers/preflightChecks.ts tests/handlers/preflightChecks.test.ts tests/integration/messageHandler.integration.test.ts
git commit -m "feat: preflight clarification block shows context and offers cancel"
```

---

### Task 9: cancel action handler + app.ts registration
> **Amended after code review (2026-06-10):** the original prescription stripped all blocks on the delete-failure path — telling the user to "try again" while removing the only button that can. The failure path now rewrites the message with `buildCancelFailedBlocks` (failure copy + retry button re-entering the same idempotent handler).

> **Amended after final review (2026-06-10):** the malformed-payload early return in the `app.action` registration was silent — indistinguishable from a working cancel in logs. It now emits `clarification.cancel.malformed_payload` with which fields were missing before returning.

**Files:**
- Create: `src/handlers/clarificationCancel.ts`
- Modify: `src/slack/clarificationBlocks.ts` (CANCEL_FAILED_TEXT + buildCancelFailedBlocks)
- Modify: `src/app.ts` (new `app.action` registration after the `refine_assumptions` block, ~line 271)
- Test: `tests/handlers/clarificationCancel.test.ts`
- Test: `tests/slack/clarificationBlocks.test.ts` (new describe)

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebClient } from '@slack/web-api';

vi.mock('../../src/state/clarificationState.js', () => ({
  deleteClarificationState: vi.fn(),
}));
vi.mock('../../src/logging.js', () => ({
  rootLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { deleteClarificationState } from '../../src/state/clarificationState.js';
import { rootLogger } from '../../src/logging.js';
import { handleClarificationCancel } from '../../src/handlers/clarificationCancel.js';

const mockUpdate = vi.fn();
const mockClient = { chat: { update: mockUpdate } } as unknown as WebClient;

const params = {
  clarificationId: 'clar_1',
  channel: 'C1',
  messageTs: '123.456',
  client: mockClient,
};

describe('handleClarificationCancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue({ ok: true });
    vi.mocked(deleteClarificationState).mockResolvedValue(undefined);
  });

  it('deletes the state and updates the message to the cancelled copy', async () => {
    await handleClarificationCancel(params);

    expect(deleteClarificationState).toHaveBeenCalledWith('clar_1');
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1',
        ts: '123.456',
        text: 'No problem — cancelled. Ask me something new whenever.',
        blocks: [],
      }),
    );
  });

  it('degrades with retry copy and keeps a retry button when the delete fails', async () => {
    vi.mocked(deleteClarificationState).mockRejectedValue(new Error('firestore down'));

    await expect(handleClarificationCancel(params)).resolves.toBeUndefined();

    const call = mockUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(call.text).toBe("Hmm, I couldn't cancel that just now — try again in a moment.");
    const blocksJson = JSON.stringify(call.blocks);
    expect(blocksJson).toContain('"action_id":"clarification_cancel"');
    expect(blocksJson).toContain('"value":"clar_1"');
    expect(rootLogger.error).toHaveBeenCalledWith(
      expect.anything(),
      'clarification.cancel.delete_failed',
    );
  });

  it('does not throw when the message update fails', async () => {
    mockUpdate.mockRejectedValue(new Error('message_not_found'));
    await expect(handleClarificationCancel(params)).resolves.toBeUndefined();
    expect(rootLogger.warn).toHaveBeenCalledWith(
      expect.anything(),
      'clarification.cancel.update_failed',
    );
  });
});
```

The `rootLogger` import was added next to the other imports from mocked modules.

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/handlers/clarificationCancel.test.ts`
Expected: FAIL — module does not exist.

**Step 3: Write the implementation**

`src/handlers/clarificationCancel.ts`:

```typescript
import type { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/types';
import { deleteClarificationState } from '../state/clarificationState.js';
import {
  buildCancelFailedBlocks,
  CANCEL_FAILED_TEXT,
} from '../slack/clarificationBlocks.js';
import { rootLogger } from '../logging.js';

export interface ClarificationCancelParams {
  clarificationId: string;
  channel: string;
  /** ts of the message whose button was clicked — the one we rewrite. */
  messageTs: string;
  client: WebClient;
}

/**
 * Cancels a pending clarification. Firestore delete is idempotent (deleting a
 * missing doc succeeds), so a double-click, an expiry race, or a click on the
 * other surface's stale button all land on the same cancelled copy.
 */
export async function handleClarificationCancel(
  params: ClarificationCancelParams,
): Promise<void> {
  const { clarificationId, channel, messageTs, client } = params;

  let text = 'No problem — cancelled. Ask me something new whenever.';
  let blocks: Record<string, unknown>[] = [];
  try {
    await deleteClarificationState(clarificationId);
  } catch (err) {
    rootLogger.error(
      { error: (err as Error).message, clarificationId },
      'clarification.cancel.delete_failed',
    );
    // Keep a retry affordance: stripping all blocks here would tell the user
    // to "try again" while removing the only button that can.
    text = CANCEL_FAILED_TEXT;
    blocks = buildCancelFailedBlocks(clarificationId);
  }

  await client.chat
    .update({ channel, ts: messageTs, text, blocks: blocks as unknown as KnownBlock[] })
    .catch((err) =>
      rootLogger.warn(
        { error: (err as Error).message, clarificationId },
        'clarification.cancel.update_failed',
      ),
    );
}
```

Append to `src/slack/clarificationBlocks.ts`:

```typescript
/** Copy for a failed cancel — also the message fallback text in the handler. */
export const CANCEL_FAILED_TEXT =
  "Hmm, I couldn't cancel that just now — try again in a moment.";

/** Shown when the cancel delete fails: the failure copy plus a retry button. */
export function buildCancelFailedBlocks(
  clarificationId: string,
): Record<string, unknown>[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: CANCEL_FAILED_TEXT },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Try again' },
          action_id: 'clarification_cancel',
          value: clarificationId,
        },
      ],
    },
  ];
}
```

In `src/app.ts`, after the `refine_assumptions` registration (match the surrounding `(body as any)` idiom — app.ts owns the payload casts, the handler owns the logic):

```typescript
// "Never mind — cancel" on a pending clarification
app.action('clarification_cancel', async ({ action, ack, body, client }) => {
  await ack();
  const clarificationId = (action as { value?: string }).value;
  const channel = (body as any).channel?.id;
  const messageTs = (body as any).message?.ts;
  if (!clarificationId || !channel || !messageTs) {
    rootLogger.warn(
      { hasId: !!clarificationId, hasChannel: !!channel, hasTs: !!messageTs },
      'clarification.cancel.malformed_payload',
    );
    return;
  }
  await handleClarificationCancel({ clarificationId, channel, messageTs, client });
});
```

Add the import next to the other handler imports:

```typescript
import { handleClarificationCancel } from './handlers/clarificationCancel.js';
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/handlers/clarificationCancel.test.ts` then `npm run typecheck`
Expected: 3 passed; typecheck clean.

**Step 5: Commit**

```bash
git add src/handlers/clarificationCancel.ts tests/handlers/clarificationCancel.test.ts src/app.ts
git commit -m "feat: clarification cancel action handler"
```

---

## Item 2 — Help / onboarding surface

### Task 10: help block builder

> **Amended after code review (2026-06-10):** the original copy omitted the *Show SQL* button (the most trust-central response affordance, present on every answer since `94f136f`), claimed `/anna` works "in any channel" (posting fails with `not_in_channel` where Anna isn't a member), and said "Every answer has buttons" for formats (format overrides are hidden for zero-row/scalar results). Copy corrected; the design doc's button list was amended in the same change set.

> **Amended after Task 12 code review (2026-06-10):** the builder originally returned `Record<string, unknown>[]`, forcing an `as unknown as KnownBlock[]` cast at every call site (duplicated across Tasks 11 and 12). It now returns `KnownBlock[]` directly — compile-time block checking, no casts.

> **Amended after final review (2026-06-10):** the template-boundary test originally used a deny-regex of client names — embedding the very vocabulary it guards against in the template repo. It now pins the three generic example questions positively and denies only `ga4` (public dbt-ga4 package vocabulary, not a client identifier).

**Files:**
- Create: `src/slack/helpBlocks.ts`
- Test: `tests/slack/helpBlocks.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { buildHelpBlocks } from '../../src/slack/helpBlocks.js';

describe('buildHelpBlocks', () => {
  const blocks = buildHelpBlocks();
  const json = JSON.stringify(blocks);

  it('covers asking, clarification, escalation, and the response buttons', () => {
    expect(json).toContain('/anna');
    expect(json).toContain('clarifying question');
    expect(json).toContain('data team');
    expect(json).toContain('feedback');
    expect(json).toContain('the SQL I ran');
  });

  it('contains example questions', () => {
    expect(json).toContain('For example');
  });

  it('stays template-generic (no client-specific vocabulary)', () => {
    // The template boundary applies to help copy too — implementations override
    // examples. Pin the generic examples positively (a deny-list of client names
    // would itself embed client vocabulary in the template).
    expect(json).toContain('How many orders did we get last week?');
    expect(json).toContain('What were the top products by revenue last month?');
    expect(json).toContain('How does signup volume compare to the previous quarter?');
    expect(json).not.toMatch(/ga4/i);
  });

  it('uses only blocks valid on both message and home surfaces', () => {
    const types = blocks.map((b) => b.type);
    for (const t of types) {
      expect(['header', 'section', 'context', 'divider']).toContain(t);
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/slack/helpBlocks.test.ts`
Expected: FAIL — module does not exist.

**Step 3: Write the implementation**

`src/slack/helpBlocks.ts`:

```typescript
import type { KnownBlock } from '@slack/types';

/**
 * Static help/onboarding content, shared by `/anna help` (ephemeral message)
 * and the App Home tab. Template-generic by design: no client table names,
 * domains, or metrics — implementations replace the examples with their own.
 * Only header/section/context/divider blocks: valid on both surfaces.
 */
export function buildHelpBlocks(): KnownBlock[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: '👋 I\'m Anna Lytics' },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          'I answer questions about our data in plain English — I translate your question ' +
          'into SQL, run it against the warehouse, and reply with the results.',
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*How to ask*\n' +
          '• `/anna <your question>` in any channel I\'ve been added to\n' +
          '• @mention me in a channel\n' +
          '• DM me directly\n\n' +
          'For example: _"How many orders did we get last week?"_ · ' +
          '_"What were the top products by revenue last month?"_ · ' +
          '_"How does signup volume compare to the previous quarter?"_',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*What to expect*\n' +
          '• If your question is ambiguous, I\'ll ask a *clarifying question* first — ' +
          'answer it (or cancel) and I\'ll continue.\n' +
          '• If I\'m not confident in an answer, I\'ll *ask the data team* and follow up ' +
          'in your thread when they respond.\n' +
          '• Answers include buttons for *feedback* (👍/👎), *my reasoning*, and ' +
          '*the SQL I ran* — plus alternate formats (table, summary, CSV) when the ' +
          'result shape supports them.',
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'There\'s an hourly per-person query limit, and large/expensive queries are blocked before they run.',
        },
      ],
    },
  ];
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/slack/helpBlocks.test.ts`
Expected: 4 passed.

**Step 5: Commit**

```bash
git add src/slack/helpBlocks.ts tests/slack/helpBlocks.test.ts
git commit -m "feat: add help block builder"
```

---

### Task 11: `/anna help` and bare `/anna` intercept

> **Amended after code review (2026-06-10):** `chat.postEphemeral` requires conversation access and throws `channel_not_found` in private channels/DMs the bot isn't in — silent failure exactly where a new user first tries `/anna help`. The intercept now uses Bolt's `respond()` (response_url-based: ephemeral by default, membership-free). A third test pins that questions starting with "help" still reach the pipeline.

> **Amended after Task 12 code review (2026-06-10):** `buildHelpBlocks()` now returns `KnownBlock[]` (see Task 10's note), so the `as unknown as KnownBlock[]` cast and the `KnownBlock` type import are gone.

**Files:**
- Modify: `src/handlers/commands.ts` (immediately after `await ack();`, before the rate-limit check, ~line 15)
- Test: `tests/handlers/commands.test.ts` (extend — read its harness first and reuse its mocked client/payload builders)

**Step 1: Write the failing tests**

Match the existing harness in `tests/handlers/commands.test.ts` (it registers the command via a mocked Bolt `App` and invokes the captured listener). The new cases:

```typescript
  it('responds to "/anna help" ephemerally without touching rate limit or intake', async () => {
    await invokeCommand({ text: '  HELP  ' }); // trim + case-insensitive

    expect(mockRespond).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'How to use Anna Lytics',
        blocks: expect.arrayContaining([expect.objectContaining({ type: 'header' })]),
      }),
    );
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockMaybeHandleSlackIntake).not.toHaveBeenCalled();
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('treats bare "/anna" as a help request', async () => {
    await invokeCommand({ text: '' });
    expect(mockRespond).toHaveBeenCalled();
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('does not treat questions starting with "help" as help requests', async () => {
    await invokeCommand({ text: "help me count last week's sessions" });

    expect(mockRespond).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).toHaveBeenCalled();
  });
```

(Adapt `invokeCommand`/mock names to the file's existing helpers; wire the captured command listener with a hoisted `respond` mock.)

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/handlers/commands.test.ts`
Expected: new tests FAIL (pipeline runs instead).

**Step 3: Write the implementation**

In `src/handlers/commands.ts` — add the import:

```typescript
import { buildHelpBlocks } from '../slack/helpBlocks.js';
```

Add `respond` to the listener's destructured args (`async ({ command, ack, respond, client })`), then immediately after `await ack();` (before `getConfig()`/rate limiting — help must cost nothing: no rate budget, no Flash intake call, no thread):

```typescript
    const trimmed = command.text.trim().toLowerCase();
    if (!trimmed || trimmed === 'help') {
      // respond() goes through the payload's response_url: ephemeral by default
      // and — unlike chat.postEphemeral — works in conversations the bot is not
      // a member of, which is exactly where a new user will try `/anna help`.
      await respond({
        text: 'How to use Anna Lytics',
        blocks: buildHelpBlocks(),
      });
      return;
    }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/handlers/commands.test.ts`
Expected: all pass.

**Step 5: Commit**

```bash
git add src/handlers/commands.ts tests/handlers/commands.test.ts
git commit -m "feat: /anna help and bare /anna show the help surface"
```

---

### Task 12: App Home tab

> **Amended after code review (2026-06-10):** `buildHelpBlocks()` now returns `KnownBlock[]` (see Task 10's note), so the `as unknown as KnownBlock[]` cast and the `KnownBlock` type import are gone. The README subsection was also renamed `App Home Messages` → `App Home`, since it now covers both the Home and Messages tabs.

> **Amended after final review (2026-06-10):** the publish-failure test only asserted "does not throw"; it now also asserts the `app_home.publish_failed` warn fires with the error message, so a silently-swallowed failure can't pass.

**Files:**
- Create: `src/handlers/appHome.ts`
- Modify: `src/app.ts` (call `registerAppHome(app)` next to `registerCommands(app, ...)`, ~line 170)
- Modify: `README.md` (Slack app setup: App Home feature + `app_home_opened` event subscription)
- Test: `tests/handlers/appHome.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { App } from '@slack/bolt';

vi.mock('../../src/logging.js', () => ({
  rootLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { registerAppHome } from '../../src/handlers/appHome.js';
import { rootLogger } from '../../src/logging.js';

const mockPublish = vi.fn();
let eventHandler: (args: {
  event: { tab?: string; user: string };
  client: { views: { publish: typeof mockPublish } };
}) => Promise<void>;

const mockApp = {
  event: vi.fn((name: string, handler: typeof eventHandler) => {
    if (name === 'app_home_opened') eventHandler = handler;
  }),
} as unknown as App;

const client = { views: { publish: mockPublish } };

describe('registerAppHome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPublish.mockResolvedValue({ ok: true });
    registerAppHome(mockApp);
  });

  it('publishes the home view on app_home_opened for the home tab', async () => {
    await eventHandler({ event: { tab: 'home', user: 'U1' }, client });

    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'U1',
        view: expect.objectContaining({ type: 'home' }),
      }),
    );
  });

  it('ignores the messages tab', async () => {
    await eventHandler({ event: { tab: 'messages', user: 'U1' }, client });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('does not throw when publish fails, and logs the failure', async () => {
    mockPublish.mockRejectedValue(new Error('not_enabled'));
    await expect(
      eventHandler({ event: { tab: 'home', user: 'U1' }, client }),
    ).resolves.toBeUndefined();
    expect(rootLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'not_enabled' }),
      'app_home.publish_failed',
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/handlers/appHome.test.ts`
Expected: FAIL — module does not exist.

**Step 3: Write the implementation**

`src/handlers/appHome.ts`:

```typescript
import type { App } from '@slack/bolt';
import { buildHelpBlocks } from '../slack/helpBlocks.js';
import { rootLogger } from '../logging.js';

/**
 * App Home tab = the same static help content as `/anna help`, re-published on
 * every open (stateless). The event fires for the Messages tab too — only the
 * Home tab carries a publishable view.
 */
export function registerAppHome(app: App): void {
  app.event('app_home_opened', async ({ event, client }) => {
    if (event.tab !== 'home') return;
    await client.views
      .publish({
        user_id: event.user,
        view: { type: 'home', blocks: buildHelpBlocks() },
      })
      .catch((err) =>
        rootLogger.warn({ error: (err as Error).message }, 'app_home.publish_failed'),
      );
  });
}
```

In `src/app.ts`, next to `registerCommands(app, getConfig, getTables);`:

```typescript
import { registerAppHome } from './handlers/appHome.js';
```

```typescript
registerAppHome(app);
```

`README.md` — in the Slack app configuration section, add: enable **App Home → Home Tab**, and add `app_home_opened` to Event Subscriptions (no new OAuth scope needed).

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/handlers/appHome.test.ts` then `npm run typecheck`
Expected: 3 passed; typecheck clean (if the Bolt event payload type complains about `tab`, narrow via the `AppHomeOpenedEvent` type from `@slack/types`).

**Step 5: Commit**

```bash
git add src/handlers/appHome.ts tests/handlers/appHome.test.ts src/app.ts README.md
git commit -m "feat: App Home help surface"
```

---

## Task 13: governance update + final verification

**Files:**
- Modify: `docs/trajectory-governance.md`
- (No code.)

**Step 1: Update the governance head sections**

In "Sanctioned UX-Trust Items": mark all three items shipped 2026-06-10 (keep the section — it documents the rationale), noting item 1 satisfies the Tranche Horizon's precondition for second-domain selection (the gate itself still requires the acceptance run).

**Step 2: Append an Evidence Log entry**

Dated 2026-06-10, recording: what shipped per item (the `pending_notifications` queue + sweep delivery; clarification cancel on both surfaces; `/anna help` + App Home), the design/implementation doc paths, the boundary notes (notification fires at approval not CI sync; help copy is template-generic; no new measurement machinery — freeze respected), and the operator step (apply the new TTL policy + Slack app config: `app_home_opened` subscription, Home Tab toggle).

**Step 3: Full verification**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass (859 at base + ~25 new).

**Step 4: Commit**

```bash
git add docs/trajectory-governance.md
git commit -m "docs: record UX-trust items in trajectory governance"
```

---

## Post-merge operator steps (not part of this plan's code)

Recorded here so they reach the install passdown (`docs/plans/`, gitignored):

1. Apply the new TTL policy: `gcloud firestore fields ttls update expiresAt --collection-group=pending_notifications --enable-ttl`.
2. Slack app config: add `app_home_opened` to Event Subscriptions; enable App Home → Home Tab.
3. Deploy via the local-docker procedure (cloud builds drop dbt artifacts), then `GET /health/doctor` to confirm the revision.
4. Verify one end-to-end notification: approve a test candidate, confirm the next sweep's response JSON shows `notificationsDelivered: 1` and the message lands in the originating thread.
