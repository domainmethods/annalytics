import { parse as parseYaml } from 'yaml';
import type { Teaching } from './types.js';

const REQUIRED_FIELDS = ['id', 'reasoning', 'models_referenced'] as const;

export function parseTeachingFile(yamlContent: string): Teaching[] {
  const parsed = parseYaml(yamlContent) as { teachings?: unknown[] };
  if (!parsed?.teachings || !Array.isArray(parsed.teachings)) {
    throw new Error('Teaching file must have a "teachings" array');
  }
  return parsed.teachings.map((raw, index) =>
    validateTeaching(raw as Record<string, unknown>, index),
  );
}

function validateTeaching(raw: Record<string, unknown>, index: number): Teaching {
  for (const field of REQUIRED_FIELDS) {
    if (raw[field] === undefined || raw[field] === null) {
      throw new Error(
        `Teaching at index ${index} is missing required field: ${field}`,
      );
    }
  }

  const questionPatterns = asStringArray(raw.question_patterns) ?? [];
  if (questionPatterns.length === 0) {
    console.warn(`Teaching "${String(raw.id)}" has no question_patterns — it may not be retrievable via RAG`);
  }

  return {
    id: String(raw.id),
    question_patterns: questionPatterns,
    sanctioned_sql: raw.sanctioned_sql != null ? String(raw.sanctioned_sql) : null,
    reasoning: String(raw.reasoning),
    models_referenced: asStringArray(raw.models_referenced) ?? [],
    tags: asStringArray(raw.tags) ?? [],
    author: String(raw.author ?? ''),
    updated: String(raw.updated ?? ''),
  };
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(String);
}
