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

// The Gemini 3.x `thinkingConfig.thinkingLevel` axis. `'default'` is a SENTINEL,
// not a real API value: it means "omit thinkingConfig and let the model manage its
// own budget" (see modelGateway). Lives here — next to the model registry it pairs
// with — so the per-model capability map below and every sweep/profile can speak one
// type without importing nodeProfiles (which would invert the dependency direction).
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'default';

/** A model the registry knows about, as a (tier, version) coordinate rather than a
 *  raw id — the form every sizing sweep and nodeProfiles override speaks. */
export interface ModelCoordinate { tier: ModelTier; version: string; }

// Sparse, real Gemini 3.x lineup. Keys are `${tier}/${version}`.
// Verify exact ids against the live model list before first deploy.
const GEMINI_3X_MODELS: Record<string, string> = {
  'flash-lite/3.1': 'gemini-3.1-flash-lite',
  'flash/3': 'gemini-3-flash-preview',
  'flash/3.5': 'gemini-3.5-flash',
  'pro/3.1': 'gemini-3.1-pro-preview',
};

// Cheapest tier first, so a floor-up sweep that walks this list left-to-right meets
// the cheapest models before the expensive ones. Tier is the dominant cost lever
// (flash-lite ≪ flash ≪ pro); version order within a tier follows the map.
const TIER_RANK: Record<ModelTier, number> = { 'flash-lite': 0, 'flash': 1, 'pro': 2 };

// Per-model DISCRETE thinking_level support, transcribed verbatim from the Gemini
// 3.x thinking docs (ai.google.dev/gemini-api/docs/thinking). `'default'` (omit
// thinkingConfig) is universally accepted and is NOT a discrete API value, so it is
// deliberately ABSENT here — callers treat it as always-safe separately. The only
// asymmetry in today's lineup: gemini-3.1-pro-preview rejects `minimal` (every Flash
// model accepts all four). Keys MUST stay in lock-step with GEMINI_3X_MODELS — the
// modelConfig test asserts every registry coordinate is annotated here, so a new
// model can't silently ship without declaring what it supports.
const MODEL_THINKING_LEVELS: Record<string, ThinkingLevel[]> = {
  'flash-lite/3.1': ['minimal', 'low', 'medium', 'high'],
  'flash/3': ['minimal', 'low', 'medium', 'high'],
  'flash/3.5': ['minimal', 'low', 'medium', 'high'],
  'pro/3.1': ['low', 'medium', 'high'],   // minimal "Not supported" for Gemini 3.1 Pro
};

/**
 * The discrete thinking levels a (tier, version) actually serves. Excludes the
 * `'default'` sentinel (universally safe — handle it separately). Returns `[]` for a
 * coordinate not in the registry: fail-CLOSED, so a typo'd model surfaces as "supports
 * nothing" rather than silently passing an unsupported level to the API. The single
 * source of truth for "can model X take thinking level Y" — the gateway, the node-profile
 * boundary guard, and the sizing sweep's Stage-2 walk all consult this rather than
 * hardcoding the pro-rejects-minimal special case in three places.
 */
export function getSupportedThinkingLevels(tier: ModelTier, version: string): ThinkingLevel[] {
  return [...(MODEL_THINKING_LEVELS[`${tier}/${version}`] ?? [])];
}

/**
 * Every Gemini 3.x (tier, version) the template knows about — the SINGLE SOURCE OF
 * TRUTH for "all the models". Sizing sweeps MUST enumerate this rather than a
 * hand-authored list: that way adding a model to GEMINI_3X_MODELS automatically
 * enrolls it in every sweep, and a partial-coverage sweep (e.g. 3 of 4 models)
 * becomes structurally impossible. Returns fresh objects so callers can't mutate
 * the registry. Ordered cheapest tier first (stable within a tier).
 */
export function listGemini3xModels(): ModelCoordinate[] {
  return Object.keys(GEMINI_3X_MODELS)
    .map((key) => {
      const slash = key.indexOf('/');
      return { tier: key.slice(0, slash) as ModelTier, version: key.slice(slash + 1) };
    })
    .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);
}

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
