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
} = vi.hoisted(() => ({
  mockRunPipeline: vi.fn(),
  mockToPipelineConfig: vi.fn(),
  mockReleaseThreadLock: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockFriendlyErrorMessage: vi.fn(),
  mockCreateTraceId: vi.fn(),
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

describe('registerCommands /anna seam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
    mockMaybeHandleSlackIntake.mockResolvedValue(false);
    mockPreflightChecks.mockResolvedValue(true);
    mockToPipelineConfig.mockReturnValue({ pipeline: true });
    mockRunPipeline.mockResolvedValue(undefined);
    mockFriendlyErrorMessage.mockReturnValue('friendly error');
    mockCreateTraceId.mockReturnValue('trace-1');
  });

  it('updates the placeholder (no orphan) when preflight blocks the request', async () => {
    mockPreflightChecks.mockResolvedValue(false);
    const client = makeClient();
    const handler = captureCommandHandler();

    await handler({ command, ack: vi.fn(), client });

    // The pipeline must not run when preflight blocks.
    expect(mockRunPipeline).not.toHaveBeenCalled();

    // The placeholder message must be updated in place (not left frozen on
    // "Understanding your question..."). It targets the same ts that was posted.
    expect(client.chat.update).toHaveBeenCalledTimes(1);
    const update = client.chat.update.mock.calls[0][0];
    expect(update.ts).toBe('status-1');
    expect(update.channel).toBe('C123');
    expect(typeof update.text).toBe('string');
    expect(update.text.length).toBeGreaterThan(0);
    expect(update.text).not.toContain('Understanding your question');

    // A blocked request is not an error — the friendly-error path is not used.
    expect(mockFriendlyErrorMessage).not.toHaveBeenCalled();
  });

  it('runs the pipeline and leaves the placeholder for the pipeline when preflight passes', async () => {
    const client = makeClient();
    const handler = captureCommandHandler();

    await handler({ command, ack: vi.fn(), client });

    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    // The handler itself does not update the placeholder on the success path —
    // runPipeline owns it from here.
    expect(client.chat.update).not.toHaveBeenCalled();
  });
});
