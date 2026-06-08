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

function modelIdOverrides(): Record<string, string> {
  const raw = process.env.MODEL_ID_OVERRIDES;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function resolveModelId(tier: ModelTier, version: string): string {
  const key = `${tier}/${version}`;
  const override = modelIdOverrides()[key];
  if (override) return override;
  const id = GEMINI_3X_MODELS[key];
  if (!id) throw new Error(`no Gemini 3.x model for tier=${tier} version=${version}`);
  return id;
}
