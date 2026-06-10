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
