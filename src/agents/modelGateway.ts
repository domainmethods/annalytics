import { AsyncLocalStorage } from 'node:async_hooks';
import type { GoogleGenAI } from '@google/genai';
import { getNodeProfile, resolveNodeModel, type NodeId } from './nodeProfiles.js';

export interface UsageRecord {
  nodeId: NodeId;
  promptTokens: number;
  candidatesTokens: number;
  thoughtsTokens: number;
  latencyMs: number;
}
type UsageSink = (r: UsageRecord) => void;

const sinkStore = new AsyncLocalStorage<UsageSink>();

let defaultSink: UsageSink | undefined;

/** Process-wide fallback sink, used when no AsyncLocalStorage-scoped sink is
 *  active. ALS sinks (withUsageSink) take precedence and fully replace it for
 *  their scope. Wiring to a concrete logger happens in app.ts — agents/ stays
 *  free of logging imports. */
export function setDefaultUsageSink(sink: UsageSink | undefined): void {
  defaultSink = sink;
}

export async function withUsageSink<T>(sink: UsageSink, fn: () => Promise<T>): Promise<T> {
  return sinkStore.run(sink, fn);
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

function recordUsage(nodeId: NodeId, usage: unknown, latencyMs: number): void {
  const sink = sinkStore.getStore() ?? defaultSink;
  if (!sink) return;
  const u = (usage ?? {}) as Record<string, unknown>;
  sink({
    nodeId,
    promptTokens: num(u.promptTokenCount),
    candidatesTokens: num(u.candidatesTokenCount),
    thoughtsTokens: num(u.thoughtsTokenCount),
    latencyMs,
  });
}

// `ai.models.generateContent` parameter type, minus the bits the seam owns.
type GenReq = Parameters<GoogleGenAI['models']['generateContent']>[0];

export async function generateForNode(
  nodeId: NodeId,
  ai: GoogleGenAI,
  request: Omit<GenReq, 'model'>,
  opts?: { modelOverride?: string },
): Promise<Awaited<ReturnType<GoogleGenAI['models']['generateContent']>>> {
  const profile = getNodeProfile(nodeId);
  const model = opts?.modelOverride ?? resolveNodeModel(nodeId);
  const config = {
    ...request.config,
    // 'default' sentinel means "send nothing". Compare against the string —
    // do NOT shorten to a truthiness check (every level is a non-empty string,
    // but keeping the explicit !== guards the sentinel contract).
    ...(profile.thinkingLevel !== 'default' && {
      thinkingConfig: { thinkingLevel: profile.thinkingLevel },
    }),
  };
  const t0 = Date.now();
  const res = await ai.models.generateContent({ ...request, model, config } as GenReq);
  recordUsage(nodeId, (res as { usageMetadata?: unknown }).usageMetadata, Date.now() - t0);
  return res;
}
