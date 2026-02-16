export interface AppConfig {
  slack: {
    botToken: string;
    signingSecret: string;
  };
  gemini: {
    apiKey: string;
    model: string;
    fileSearchStoreId?: string;
  };
  gcp: {
    projectId: string;
  };
  dbt: {
    manifestPath: string;
    catalogPath: string;
  };
  limits: {
    costGateMaxBytes: number;
    queryTimeoutMs: number;
    maxResultRows: number;
    rateLimitPerHour: number;
  };
  escalation: {
    mode: 'channel' | 'dm';
    channelId?: string;
    analystUserId?: string;
    reminderIntervalMinutes: number;
    timeoutHours: number;
  };
  port: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function parseEnvInt(name: string, defaultVal: number): number {
  const val = process.env[name];
  if (val === undefined || val === '') return defaultVal;
  const parsed = Number(val);
  if (Number.isNaN(parsed)) throw new Error(`Invalid config: ${name} must be a number, got "${val}"`);
  return parsed;
}

function parseEscalationMode(val: string | undefined): 'channel' | 'dm' {
  if (!val || val === 'channel') return 'channel';
  if (val === 'dm') return 'dm';
  throw new Error(`Invalid config: ESCALATION_MODE must be "channel" or "dm", got "${val}"`);
}

export function loadConfig(): AppConfig {
  return {
    slack: {
      botToken: requireEnv('SLACK_BOT_TOKEN'),
      signingSecret: requireEnv('SLACK_SIGNING_SECRET'),
    },
    gemini: {
      apiKey: requireEnv('GEMINI_API_KEY'),
      model: process.env.GEMINI_MODEL || 'gemini-3.0-pro',
      fileSearchStoreId: process.env.FILE_SEARCH_STORE_ID || undefined,
    },
    gcp: {
      projectId: requireEnv('GCP_PROJECT_ID'),
    },
    dbt: {
      manifestPath: process.env.DBT_MANIFEST_PATH || './dbt/manifest.json',
      catalogPath: process.env.DBT_CATALOG_PATH || './dbt/catalog.json',
    },
    limits: {
      costGateMaxBytes: parseEnvInt('COST_GATE_MAX_BYTES', 10_737_418_240),
      queryTimeoutMs: parseEnvInt('QUERY_TIMEOUT_MS', 30_000),
      maxResultRows: parseEnvInt('MAX_RESULT_ROWS', 1_000),
      rateLimitPerHour: parseEnvInt('RATE_LIMIT_PER_HOUR', 30),
    },
    escalation: {
      mode: parseEscalationMode(process.env.ESCALATION_MODE),
      channelId: process.env.ESCALATION_CHANNEL_ID || undefined,
      analystUserId: process.env.ESCALATION_ANALYST_USER_ID || undefined,
      reminderIntervalMinutes: parseEnvInt('ESCALATION_REMINDER_MINUTES', 30),
      timeoutHours: parseEnvInt('ESCALATION_TIMEOUT_HOURS', 4),
    },
    port: parseEnvInt('PORT', 3000),
  };
}
