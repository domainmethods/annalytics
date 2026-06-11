import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks for commands.ts direct dependencies ───────────
const {
  mockRunPipeline,
  mockToPipelineConfig,
  mockReleaseThreadLock,
  mockCheckRateLimit,
  mockFriendlyErrorMessage,
  mockCreateTraceId,
  mockMaybeHandleSlackIntake,
  mockPreflightChecks,
  mockRespond,
} = vi.hoisted(() => ({
  mockRunPipeline: vi.fn(),
  mockToPipelineConfig: vi.fn(),
  mockReleaseThreadLock: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockFriendlyErrorMessage: vi.fn(),
  mockCreateTraceId: vi.fn(),
  mockMaybeHandleSlackIntake: vi.fn(),
  mockPreflightChecks: vi.fn(),
  mockRespond: vi.fn(),
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
vi.mock('../../src/errors.js', () => ({
  friendlyErrorMessage: mockFriendlyErrorMessage,
}));
vi.mock('../../src/logging.js', () => ({
  createTraceId: mockCreateTraceId,
}));
vi.mock('../../src/handlers/slackIntake.js', () => ({
  maybeHandleSlackIntake: mockMaybeHandleSlackIntake,
}));
vi.mock('../../src/handlers/preflightChecks.js', () => ({
  preflightChecks: mockPreflightChecks,
}));

import { registerCommands } from '../../src/handlers/commands.js';

function captureCommandHandler() {
  let handler: any;
  const app = { command: vi.fn((_name: string, h: any) => { handler = h; }) } as any;
  const config = { limits: { rateLimitPerHour: 50 }, gemini: { apiKey: 'api-key' } };
  registerCommands(app, () => config as any, () => []);
  expect(app.command).toHaveBeenCalledWith('/anna', expect.any(Function));
  return handler;
}

function makeClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: 'status-1' }),
      update: vi.fn().mockResolvedValue({}),
    },
  } as any;
}

const command = { channel_id: 'C123', user_id: 'U1', text: 'how many orders?' };
const STATUS_TEXT = 'Got it. Let me get things ready...';

async function invokeCommand(overrides: Partial<typeof command> = {}) {
  const client = makeClient();
  const handler = captureCommandHandler();
  await handler({ command: { ...command, ...overrides }, ack: vi.fn(), respond: mockRespond, client });
  return client;
}

describe('registerCommands /anna seam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
    mockReleaseThreadLock.mockResolvedValue(undefined);
    mockMaybeHandleSlackIntake.mockResolvedValue(false);
    mockPreflightChecks.mockResolvedValue(true);
    mockToPipelineConfig.mockReturnValue({ pipeline: true });
    mockRunPipeline.mockResolvedValue(undefined);
    mockFriendlyErrorMessage.mockReturnValue('friendly error');
    mockCreateTraceId.mockReturnValue('trace-1');
    mockRespond.mockResolvedValue({});
  });

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

  it('updates the placeholder (no orphan) when preflight blocks the request', async () => {
    mockPreflightChecks.mockResolvedValue(false);
    const client = makeClient();
    const handler = captureCommandHandler();

    await handler({ command, ack: vi.fn(), respond: mockRespond, client });

    // The pipeline must not run when preflight blocks.
    expect(mockRunPipeline).not.toHaveBeenCalled();

    // The placeholder message must be updated in place. It targets the same ts
    // that was posted.
    expect(client.chat.update).toHaveBeenCalledTimes(1);
    const update = client.chat.update.mock.calls[0][0];
    expect(update.ts).toBe('status-1');
    expect(update.channel).toBe('C123');
    expect(typeof update.text).toBe('string');
    expect(update.text.length).toBeGreaterThan(0);
    expect(update.text).not.toContain(STATUS_TEXT);

    // A blocked request is not an error — the friendly-error path is not used.
    expect(mockFriendlyErrorMessage).not.toHaveBeenCalled();
  });

  it('runs the pipeline and leaves the placeholder for the pipeline when preflight passes', async () => {
    const client = makeClient();
    const handler = captureCommandHandler();

    await handler({ command, ack: vi.fn(), respond: mockRespond, client });

    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      text: STATUS_TEXT,
    });
    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    // The handler itself does not update the placeholder on the success path —
    // runPipeline owns it from here.
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it('tells the user to invite the bot when the placeholder post hits channel_not_found', async () => {
    const client = makeClient();
    client.chat.postMessage.mockRejectedValue({ data: { error: 'channel_not_found' } });
    const handler = captureCommandHandler();

    await handler({ command, ack: vi.fn(), respond: mockRespond, client });

    expect(mockRespond).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('/invite') }),
    );
    expect(mockRunPipeline).not.toHaveBeenCalled();
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it('falls back to respond() when the rate-limit notice hits not_in_channel', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfterMinutes: 10 });
    const client = makeClient();
    client.chat.postMessage.mockRejectedValue({ data: { error: 'not_in_channel' } });
    const handler = captureCommandHandler();

    await handler({ command, ack: vi.fn(), respond: mockRespond, client });

    expect(mockRespond).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('/invite') }),
    );
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('releases the lock and updates the placeholder on a pipeline error', async () => {
    mockRunPipeline.mockRejectedValue(new Error('boom'));
    const client = makeClient();
    const handler = captureCommandHandler();

    await handler({ command, ack: vi.fn(), respond: mockRespond, client });

    expect(mockReleaseThreadLock).toHaveBeenCalledWith('status-1');
    expect(client.chat.update).toHaveBeenCalledWith({
      channel: 'C123',
      ts: 'status-1',
      text: 'friendly error',
    });
    expect(mockRespond).not.toHaveBeenCalled();
  });

  it('responds with a friendly error when a failure precedes the placeholder', async () => {
    mockMaybeHandleSlackIntake.mockRejectedValue(new Error('intake down'));
    const client = makeClient();
    const handler = captureCommandHandler();

    await handler({ command, ack: vi.fn(), respond: mockRespond, client });

    // No placeholder was ever posted, so there is no lock to release and no
    // message to update — respond() is the only remaining surface.
    expect(mockReleaseThreadLock).not.toHaveBeenCalled();
    expect(client.chat.update).not.toHaveBeenCalled();
    expect(mockRespond).toHaveBeenCalledWith({ text: 'friendly error' });
  });
});
