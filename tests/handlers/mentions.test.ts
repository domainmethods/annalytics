import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks for mentions.ts direct dependencies ───────────
const {
  mockRunPipeline,
  mockToPipelineConfig,
  mockReleaseThreadLock,
  mockCheckRateLimit,
  mockClaimSlackEvent,
  mockExtractSlackEventId,
  mockMarkSlackEventVisible,
  mockReleaseSlackEventClaim,
  mockMaybeHandleSlackIntake,
  mockPreflightChecks,
  mockRecordThreadParticipation,
  mockGetRefinementTarget,
  mockRouteFollowUp,
  mockConsumeRefinementTarget,
} = vi.hoisted(() => ({
  mockRunPipeline: vi.fn(),
  mockToPipelineConfig: vi.fn(),
  mockReleaseThreadLock: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockClaimSlackEvent: vi.fn(),
  mockExtractSlackEventId: vi.fn(),
  mockMarkSlackEventVisible: vi.fn(),
  mockReleaseSlackEventClaim: vi.fn(),
  mockMaybeHandleSlackIntake: vi.fn(),
  mockPreflightChecks: vi.fn(),
  mockRecordThreadParticipation: vi.fn(),
  mockGetRefinementTarget: vi.fn(),
  mockRouteFollowUp: vi.fn(),
  mockConsumeRefinementTarget: vi.fn(),
}));

vi.mock('../../src/pipeline.js', () => ({
  runPipeline: mockRunPipeline,
  toPipelineConfig: mockToPipelineConfig,
}));
vi.mock('../../src/state/threadLock.js', () => ({
  releaseThreadLock: mockReleaseThreadLock,
}));
vi.mock('../../src/state/rateLimiter.js', () => ({
  checkRateLimit: mockCheckRateLimit,
}));
vi.mock('../../src/state/slackEventDedupe.js', () => ({
  claimSlackEvent: mockClaimSlackEvent,
  extractSlackEventId: mockExtractSlackEventId,
  markSlackEventVisible: mockMarkSlackEventVisible,
  releaseSlackEventClaim: mockReleaseSlackEventClaim,
}));
vi.mock('../../src/handlers/slackIntake.js', () => ({
  maybeHandleSlackIntake: mockMaybeHandleSlackIntake,
}));
vi.mock('../../src/handlers/preflightChecks.js', () => ({
  preflightChecks: mockPreflightChecks,
}));

vi.mock('../../src/state/threadParticipation.js', () => ({
  recordThreadParticipation: mockRecordThreadParticipation,
}));
vi.mock('../../src/state/refinementTarget.js', () => ({
  saveRefinementTarget: vi.fn(),
  getRefinementTarget: mockGetRefinementTarget,
  consumeRefinementTarget: mockConsumeRefinementTarget,
}));
vi.mock('../../src/handlers/followUpRouter.js', () => ({
  routeFollowUp: mockRouteFollowUp,
}));

import { registerMentions } from '../../src/handlers/mentions.js';

const STATUS_TEXT = 'Got it. Let me get things ready...';

function captureMentionHandler() {
  let handler: any;
  const app = { event: vi.fn((_name: string, h: any) => { handler = h; }) } as any;
  const config = { limits: { rateLimitPerHour: 50 }, gemini: { apiKey: 'api-key' } };
  registerMentions(app, () => config as any, () => []);
  expect(app.event).toHaveBeenCalledWith('app_mention', expect.any(Function));
  return handler;
}

function makeClient() {
  return { chat: { postMessage: vi.fn().mockResolvedValue({ ts: 'status-1' }) } } as any;
}

describe('registerMentions app_mention seam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExtractSlackEventId.mockReturnValue('evt-1');
    mockClaimSlackEvent.mockResolvedValue(true);
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
    mockPreflightChecks.mockResolvedValue(true);
    mockToPipelineConfig.mockReturnValue({ pipeline: true });
    mockMarkSlackEventVisible.mockResolvedValue(undefined);
    mockReleaseThreadLock.mockResolvedValue(undefined);
    mockRunPipeline.mockResolvedValue(undefined);
    mockRecordThreadParticipation.mockResolvedValue(undefined);
    mockGetRefinementTarget.mockResolvedValue(null);
    mockRouteFollowUp.mockResolvedValue(undefined);
    mockConsumeRefinementTarget.mockResolvedValue(undefined);
  });

  it('on an immediate response, does not post the status message and does not run the pipeline', async () => {
    mockMaybeHandleSlackIntake.mockResolvedValue(true);
    const handler = captureMentionHandler();
    const client = makeClient();

    await handler({
      event: { text: '<@U1> hi', user: 'U2', channel: 'C1', ts: 'T1' },
      body: {},
      client,
    });

    expect(mockMaybeHandleSlackIntake).toHaveBeenCalledTimes(1);
    expect(mockRunPipeline).not.toHaveBeenCalled();
    const postedTexts = client.chat.postMessage.mock.calls.map((c: any[]) => c[0].text);
    expect(postedTexts).not.toContain(STATUS_TEXT);
    // intake owns visibility on this path; the handler must not also claim it back
    expect(mockReleaseSlackEventClaim).not.toHaveBeenCalled();
  });

  it('on the analytics route, posts the status message and runs the pipeline', async () => {
    mockMaybeHandleSlackIntake.mockResolvedValue(false);
    const handler = captureMentionHandler();
    const client = makeClient();

    await handler({
      event: { text: '<@U1> show leads last month', user: 'U2', channel: 'C1', ts: 'T1' },
      body: {},
      client,
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C1',
      thread_ts: 'T1',
      text: STATUS_TEXT,
    });
    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    const pipelineArg = mockRunPipeline.mock.calls[0][0];
    expect(pipelineArg).toMatchObject({
      question: 'show leads last month',
      channel: 'C1',
      threadTs: 'T1',
      statusMsgTs: 'status-1',
    });
  });

  it('wires the intake dedupe/lock cleanup callbacks to this event and thread', async () => {
    mockMaybeHandleSlackIntake.mockResolvedValue(true);
    const handler = captureMentionHandler();
    const client = makeClient();

    await handler({
      event: { text: '<@U1> thanks', user: 'U2', channel: 'C1', ts: 'T1' },
      body: {},
      client,
    });

    const intakeArg = mockMaybeHandleSlackIntake.mock.calls[0][0];
    expect(intakeArg).toMatchObject({ text: 'thanks', channel: 'C1', threadTs: 'T1', apiKey: 'api-key' });

    await intakeArg.markVisible();
    expect(mockMarkSlackEventVisible).toHaveBeenCalledWith('evt-1');
    await intakeArg.releaseLock();
    expect(mockReleaseThreadLock).toHaveBeenCalledWith('C1', 'T1', expect.any(String));
  });

  describe('thread participation (#53)', () => {
    it('leaves marking an immediate intake reply to intake itself', async () => {
      mockMaybeHandleSlackIntake.mockResolvedValue(true);
      const handler = captureMentionHandler();
      await handler({ event: { text: '<@U1> hi', user: 'U2', channel: 'C1', ts: 'T1' }, body: {}, client: makeClient() });
      expect(mockMaybeHandleSlackIntake).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C1', threadTs: 'T1' }));
      expect(mockRecordThreadParticipation).not.toHaveBeenCalled();
    });

    it('marks the thread when the status message posts, before the pipeline runs', async () => {
      mockMaybeHandleSlackIntake.mockResolvedValue(false);
      mockRunPipeline.mockImplementation(async () => {
        expect(mockRecordThreadParticipation).toHaveBeenCalledWith('C1', 'T0');
      });
      const handler = captureMentionHandler();
      await handler({ event: { text: '<@U1> leads', user: 'U2', channel: 'C1', ts: 'T1', thread_ts: 'T0' }, body: {}, client: makeClient() });
      expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    });

    it('does not mark the thread for a rate-limit reply', async () => {
      mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfterMinutes: 5 });
      const handler = captureMentionHandler();
      await handler({ event: { text: '<@U1> leads', user: 'U2', channel: 'C1', ts: 'T1' }, body: {}, client: makeClient() });
      expect(mockRecordThreadParticipation).not.toHaveBeenCalled();
    });

    it('still runs the pipeline when the mark fails', async () => {
      mockMaybeHandleSlackIntake.mockResolvedValue(false);
      mockRecordThreadParticipation.mockRejectedValue(new Error('firestore down'));
      const handler = captureMentionHandler();
      await handler({ event: { text: '<@U1> leads', user: 'U2', channel: 'C1', ts: 'T1' }, body: {}, client: makeClient() });
      expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    });
  });

  describe('a mentioned reply to a refine prompt (#51)', () => {
    const threadReply = { text: '<@U1> use net revenue instead', user: 'U2', channel: 'C1', ts: 'T2', thread_ts: 'T1' };

    it('refines the picked answer instead of running a fresh query', async () => {
      mockGetRefinementTarget.mockResolvedValue('T1_S1');
      const handler = captureMentionHandler();
      const client = makeClient();

      await handler({ event: threadReply, body: {}, client });

      expect(mockGetRefinementTarget).toHaveBeenCalledWith('C1', 'T1', 'U2');
      expect(mockMaybeHandleSlackIntake).not.toHaveBeenCalled();
      expect(mockRunPipeline).not.toHaveBeenCalled();
      expect(mockRouteFollowUp).toHaveBeenCalledTimes(1);
      const args = mockRouteFollowUp.mock.calls[0];
      expect(args[0]).toBe('refinement');
      expect(args[1]).toBe('use net revenue instead');
      expect(args[2]).toBe('T1');
      expect(args[4]).toBe('status-1');
      expect(args[8]).toEqual({ refinementTargetKey: 'T1_S1' });
      expect(mockConsumeRefinementTarget).toHaveBeenCalledWith('C1', 'T1', 'U2', 'T1_S1');
      expect(mockReleaseThreadLock).toHaveBeenCalledWith('C1', 'T1', expect.any(String));
    });

    it('keeps the target when the status post fails, so a retry still refines it', async () => {
      mockGetRefinementTarget.mockResolvedValue('T1_S1');
      const handler = captureMentionHandler();
      const client = makeClient();
      client.chat.postMessage.mockRejectedValueOnce(new Error('slack down'));
      mockReleaseSlackEventClaim.mockResolvedValue(undefined);

      await expect(handler({ event: threadReply, body: {}, client })).rejects.toThrow('slack down');
      expect(mockConsumeRefinementTarget).not.toHaveBeenCalled();
      expect(mockRouteFollowUp).not.toHaveBeenCalled();
      expect(mockReleaseSlackEventClaim).toHaveBeenCalledWith('evt-1');

      await handler({ event: threadReply, body: {}, client });
      expect(mockRouteFollowUp).toHaveBeenCalledTimes(1);
      expect(mockRouteFollowUp.mock.calls[0][8]).toEqual({ refinementTargetKey: 'T1_S1' });
      expect(mockConsumeRefinementTarget).toHaveBeenCalledTimes(1);
    });

    it('runs the normal path when no refine prompt is pending', async () => {
      mockMaybeHandleSlackIntake.mockResolvedValue(false);
      const handler = captureMentionHandler();
      const client = makeClient();

      await handler({ event: threadReply, body: {}, client });

      expect(mockRouteFollowUp).not.toHaveBeenCalled();
      expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    });

    it('says so, and runs nothing, when the target cannot be read', async () => {
      mockGetRefinementTarget.mockRejectedValue(new Error('firestore down'));
      const handler = captureMentionHandler();
      const client = makeClient();

      await handler({ event: threadReply, body: {}, client });

      const texts = client.chat.postMessage.mock.calls.map((c: any[]) => c[0].text);
      expect(texts).toEqual([expect.stringContaining("couldn't load the answer you picked")]);
      expect(mockMaybeHandleSlackIntake).not.toHaveBeenCalled();
      expect(mockRouteFollowUp).not.toHaveBeenCalled();
      expect(mockRunPipeline).not.toHaveBeenCalled();
      expect(mockReleaseThreadLock).toHaveBeenCalledWith('C1', 'T1', expect.any(String));
      expect(mockMarkSlackEventVisible).toHaveBeenCalledWith('evt-1');
    });

    it('does not look up a target for a top-level mention', async () => {
      mockMaybeHandleSlackIntake.mockResolvedValue(false);
      const handler = captureMentionHandler();
      await handler({ event: { text: '<@U1> show leads', user: 'U2', channel: 'C1', ts: 'T1' }, body: {}, client: makeClient() });
      expect(mockGetRefinementTarget).not.toHaveBeenCalled();
    });
  });
});
