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

// The Gemini `thinkingConfig.thinkingLevel` axis. `'default'` is a SENTINEL,
// not a real API value: it means "omit thinkingConfig and let the model manage its
// own budget" (see modelGateway). Lives here — next to the model registry it pairs
// with — so the registry below and every sweep/profile can speak one
// type without importing nodeProfiles (which would invert the dependency direction).
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'default';

/** A model the registry knows about, as a (tier, version) coordinate rather than a
 *  raw id — the form every sizing sweep and nodeProfiles override speaks. */
export interface ModelCoordinate { tier: ModelTier; version: string; }

/** Only `retired` is enforced: it leaves sweeps but still resolves. `candidate` and
 *  `default-eligible` are labels; a sweep can recommend either as a default. */
export type ModelStatus = 'candidate' | 'default-eligible' | 'retired';

/** Google's deprecation notice for a model, copied by hand from
 *  https://aistudio.google.com/docs/deprecations. `shutdownDate` is Google's earliest
 *  possible shutdown (YYYY-MM-DD); omit it when Google names a replacement but no date. */
export interface ModelSunset {
  shutdownDate?: string;
  replacement?: string;
}

export interface RegisteredModel {
  tier: ModelTier;
  version: string;
  id: string;
  thinkingLevels: Exclude<ThinkingLevel, 'default'>[];
  inputPricePerMTok: number;
  outputPricePerMTok: number; // USD per million tokens, including thoughts
  status: ModelStatus;
  /** Set when Google's deprecations page lists this model. Sweeps still measure it, but
   *  Stage 1 ranks a model with a `shutdownDate` after viable undated models, the refresh
   *  report withholds a dated pick, and `model:discover` warns about every notice. */
  sunset?: ModelSunset;
}

// Standard USD rates for text prompts up to 200K tokens.
// https://ai.google.dev/gemini-api/docs/pricing
// `sunset` entries were checked against https://aistudio.google.com/docs/deprecations
// on 2026-11-22. Re-check that page during a model refresh.
const REGISTRY: Record<string, RegisteredModel> = {
  'flash-lite/3.1': {
    tier: 'flash-lite',
    version: '3.1',
    id: 'gemini-3.1-flash-lite',
    thinkingLevels: ['minimal', 'low', 'medium', 'high'],
    inputPricePerMTok: 0.25,
    outputPricePerMTok: 1.50,
    status: 'default-eligible',
    sunset: { shutdownDate: '2027-05-07', replacement: 'gemini-3.5-flash-lite' },
  },
  'flash/3': {
    tier: 'flash',
    version: '3',
    id: 'gemini-3-flash-preview',
    thinkingLevels: ['minimal', 'low', 'medium', 'high'],
    inputPricePerMTok: 0.50,
    outputPricePerMTok: 3.00,
    status: 'default-eligible',
    sunset: { replacement: 'gemini-3.6-flash' },
  },
  // No 2027 rate change is announced for this model, so this rate is also its 2027 rate.
  'flash-lite/3.5': {
    tier: 'flash-lite',
    version: '3.5',
    id: 'gemini-3.5-flash-lite',
    thinkingLevels: ['minimal', 'low', 'medium', 'high'],
    inputPricePerMTok: 0.30,
    outputPricePerMTok: 2.50,
    status: 'default-eligible',
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
    sunset: { replacement: 'gemini-3.6-flash' },
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
  // Gemini 4 models have codenames, not tiers. Each is filed by price and positioning:
  // Hydrogen (everyday speed) with flash, Neon/Argon/Carbon (frontier reasoning) with pro.
  // Hydrogen and Neon also support `xhigh` thinking, which the sweep does not use.
  // https://aistudio.google.com/docs/pricing
  'flash/4-hydrogen': {
    tier: 'flash',
    version: '4-hydrogen',
    id: 'gemini-4-hydrogen',
    thinkingLevels: ['low', 'medium', 'high'],
    inputPricePerMTok: 1.50,
    outputPricePerMTok: 7.50,
    status: 'default-eligible',
  },
  'pro/4-neon': {
    tier: 'pro',
    version: '4-neon',
    id: 'gemini-4-neon',
    thinkingLevels: ['low', 'medium', 'high'],
    inputPricePerMTok: 3.00,
    outputPricePerMTok: 15.00,
    status: 'candidate',
  },
  // Argon and Carbon are $2.00/$10.00 through 2026-11-30. These are the rates from
  // 2026-12-01, the ones a default chosen now will be billed at.
  'pro/4-argon': {
    tier: 'pro',
    version: '4-argon',
    id: 'gemini-4-argon',
    thinkingLevels: ['low', 'medium', 'high'],
    inputPricePerMTok: 4.00,
    outputPricePerMTok: 20.00,
    status: 'candidate',
  },
  'pro/4-carbon': {
    tier: 'pro',
    version: '4-carbon',
    id: 'gemini-4-carbon',
    thinkingLevels: ['low', 'medium', 'high'],
    inputPricePerMTok: 4.00,
    outputPricePerMTok: 20.00,
    status: 'candidate',
  },
};

// Cheapest tier first, so a floor-up sweep that walks this list left-to-right meets
// the cheapest models before the expensive ones. Tier is the dominant cost lever
// (flash-lite ≪ flash ≪ pro); within a tier, models sort by input price.
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

/** Sweep candidates: cheapest tier first, then cheapest input price within a tier (ties keep registry order). */
export function listRegisteredModels(): ModelCoordinate[] {
  return Object.values(REGISTRY)
    .filter(({ status }) => status !== 'retired')
    .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.inputPricePerMTok - b.inputPricePerMTok)
    .map(({ tier, version }) => ({ tier, version }));
}

/** One line describing Google's deprecation notice for a model, or undefined if none. */
export function describeSunset(model: Pick<RegisteredModel, 'id' | 'sunset'>): string | undefined {
  const { sunset } = model;
  if (!sunset) return undefined;
  const when = sunset.shutdownDate ? `shuts down no earlier than ${sunset.shutdownDate}` : 'superseded (no shutdown date)';
  const to = sunset.replacement ? `; replacement ${sunset.replacement}` : '';
  return `${model.id} ${when}${to}`;
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
