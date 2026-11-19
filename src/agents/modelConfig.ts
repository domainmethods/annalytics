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
// with — so the registry below and every sweep/profile can speak one
// type without importing nodeProfiles (which would invert the dependency direction).
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'default';

/** A model the registry knows about, as a (tier, version) coordinate rather than a
 *  raw id — the form every sizing sweep and nodeProfiles override speaks. */
export interface ModelCoordinate { tier: ModelTier; version: string; }

export type ModelStatus = 'candidate' | 'default-eligible' | 'retired';

export interface RegisteredModel {
  tier: ModelTier;
  version: string;
  id: string;
  thinkingLevels: Exclude<ThinkingLevel, 'default'>[];
  inputPricePerMTok: number;
  outputPricePerMTok: number; // USD per million tokens, including thoughts
  status: ModelStatus;
}

// Standard USD rates for text prompts up to 200K tokens.
// https://ai.google.dev/gemini-api/docs/pricing
const REGISTRY: Record<string, RegisteredModel> = {
  'flash-lite/3.1': {
    tier: 'flash-lite',
    version: '3.1',
    id: 'gemini-3.1-flash-lite',
    thinkingLevels: ['minimal', 'low', 'medium', 'high'],
    inputPricePerMTok: 0.25,
    outputPricePerMTok: 1.50,
    status: 'default-eligible',
  },
  'flash/3': {
    tier: 'flash',
    version: '3',
    id: 'gemini-3-flash-preview',
    thinkingLevels: ['minimal', 'low', 'medium', 'high'],
    inputPricePerMTok: 0.50,
    outputPricePerMTok: 3.00,
    status: 'default-eligible',
  },
  // No 2027 rate change is announced for this model, so this rate is also its 2027 rate.
  'flash-lite/3.5': {
    tier: 'flash-lite',
    version: '3.5',
    id: 'gemini-3.5-flash-lite',
    thinkingLevels: ['minimal', 'low', 'medium', 'high'],
    inputPricePerMTok: 0.30,
    outputPricePerMTok: 2.50,
    status: 'candidate',
  },
  // Google routes this ID to gemini-3.6-flash, so it duplicates flash/3.6 and is not
  // swept separately. Priced as flash/3.6.
  // https://aistudio.google.com/docs/deprecations#gemini-3-models
  'flash/3.5': {
    tier: 'flash',
    version: '3.5',
    id: 'gemini-3.5-flash',
    thinkingLevels: ['minimal', 'low', 'medium', 'high'],
    inputPricePerMTok: 1.50,
    outputPricePerMTok: 7.50,
    status: 'retired',
  },
  // Gemini 3.6 and 3.8 Flash are $0.75/$3.75 through 2026-12-31. These are the rates
  // from 2027-01-01, the ones a default chosen now will be billed at.
  // gemini-3.7-flash is not registered: Google routes it to gemini-3.8-flash.
  'flash/3.6': {
    tier: 'flash',
    version: '3.6',
    id: 'gemini-3.6-flash',
    thinkingLevels: ['minimal', 'low', 'medium', 'high'],
    inputPricePerMTok: 1.50,
    outputPricePerMTok: 7.50,
    status: 'candidate',
  },
  'flash/3.8': {
    tier: 'flash',
    version: '3.8',
    id: 'gemini-3.8-flash',
    thinkingLevels: ['low', 'medium', 'high'],
    inputPricePerMTok: 1.50,
    outputPricePerMTok: 7.50,
    status: 'candidate',
  },
  'pro/3.1': {
    tier: 'pro',
    version: '3.1',
    id: 'gemini-3.1-pro-preview',
    thinkingLevels: ['low', 'medium', 'high'],
    inputPricePerMTok: 2.00,
    outputPricePerMTok: 12.00,
    status: 'default-eligible',
  },
};

// Cheapest tier first, so a floor-up sweep that walks this list left-to-right meets
// the cheapest models before the expensive ones. Tier is the dominant cost lever
// (flash-lite ≪ flash ≪ pro); version order within a tier follows the map.
const TIER_RANK: Record<ModelTier, number> = { 'flash-lite': 0, 'flash': 1, 'pro': 2 };

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
  return [...(REGISTRY[`${tier}/${version}`]?.thinkingLevels ?? [])];
}

/** Sweep candidates, ordered cheapest tier first and stable within a tier. */
export function listRegisteredModels(): ModelCoordinate[] {
  return Object.values(REGISTRY)
    .filter(({ status }) => status !== 'retired')
    .map(({ tier, version }) => ({ tier, version }))
    .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);
}

export function getRegisteredModel(tier: ModelTier, version: string): RegisteredModel | undefined {
  return structuredClone(REGISTRY[`${tier}/${version}`]);
}

/** Full registry for discovery, including retired models. */
export function listAllRegisteredModels(): RegisteredModel[] {
  return structuredClone(Object.values(REGISTRY));
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
  const id = REGISTRY[key]?.id;
  if (!id) throw new Error(`no registered Gemini model for tier=${tier} version=${version}`);
  return id;
}
