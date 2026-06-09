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
    expect(mockReleaseThreadLock).toHaveBeenCalledWith('T1');
  });
});
