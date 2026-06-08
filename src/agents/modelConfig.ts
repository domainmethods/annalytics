export const DEFAULT_FLASH_MODEL = 'gemini-3-flash-preview';
export const DEFAULT_PRO_MODEL = 'gemini-3.1-pro-preview';

export function getFlashModel(): string {
  return process.env.GEMINI_FLASH_MODEL || DEFAULT_FLASH_MODEL;
}

export function getProModel(): string {
  return process.env.GEMINI_MODEL || DEFAULT_PRO_MODEL;
}

export function getJudgeModel(): string {
  return process.env.GEMINI_JUDGE_MODEL || getProModel();
}

export type ModelTier = 'flash-lite' | 'flash' | 'pro';

// Sparse, real Gemini 3.x lineup. Keys are `${tier}/${version}`.
// Verify exact ids against the live model list before first deploy.
const GEMINI_3X_MODELS: Record<string, string> = {
  'flash-lite/3.1': 'gemini-3.1-flash-lite',
  'flash/3': 'gemini-3-flash-preview',
  'flash/3.5': 'gemini-3.5-flash',
  'pro/3': 'gemini-3-pro-preview',
  'pro/3.1': 'gemini-3.1-pro-preview',
};

// resolveModelId runs on every gateway call, so cache the parsed overrides keyed
// on the raw env string (mirrors nodeProfiles.loadOverrides). The cache is NOT
// memoized away — it re-reads process.env each call so a test or the node sweep
// that mutates MODEL_ID_OVERRIDES mid-run still sees the change, but a stable env
// skips the repeated JSON.parse.
let cachedRaw: string | undefined;
let cachedOverrides: Record<string, string> = {};
let cacheValid = false;

function modelIdOverrides(): Record<string, string> {
  const raw = process.env.MODEL_ID_OVERRIDES;
  if (!raw) return {};
  if (cacheValid && raw === cachedRaw) return cachedOverrides;
  try {
    const parsed = JSON.parse(raw);
    cachedOverrides = parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    cachedOverrides = {};
  }
  cachedRaw = raw;
  cacheValid = true;
  return cachedOverrides;
}

export function resolveModelId(tier: ModelTier, version: string): string {
  const key = `${tier}/${version}`;
  const override = modelIdOverrides()[key];
  if (override) return override;
  const id = GEMINI_3X_MODELS[key];
  if (!id) throw new Error(`no Gemini 3.x model for tier=${tier} version=${version}`);
  return id;
}
