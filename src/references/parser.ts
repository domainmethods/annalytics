import { parse as parseYaml } from 'yaml';
import type { ReferenceCard } from './types.js';

const REQUIRED_SCALAR_FIELDS = [
  'id',
  'title',
  'domain',
  'grain',
  'canonical_table',
  'canonical_metric',
  'owner',
  'freshness_sla',
  'updated',
] as const;

type RequiredScalarField = typeof REQUIRED_SCALAR_FIELDS[number];

export function parseReferenceCardFile(yamlContent: string): ReferenceCard[] {
  const parsed = parseYaml(yamlContent) as { reference_cards?: unknown[] };
  if (!parsed?.reference_cards || !Array.isArray(parsed.reference_cards)) {
    throw new Error('Reference card file must have a "reference_cards" array');
  }

  return parsed.reference_cards.map((raw, index) =>
    parseReferenceCard(raw as Record<string, unknown>, index),
  );
}

function parseReferenceCard(raw: Record<string, unknown>, index: number): ReferenceCard {
  for (const field of REQUIRED_SCALAR_FIELDS) {
    if (!hasRequiredScalar(raw, field)) {
      throw new Error(
        `Reference card at index ${index} is missing required field: ${field}`,
      );
    }
  }

  return {
    id: String(raw.id),
    title: String(raw.title),
    domain: String(raw.domain),
    grain: String(raw.grain),
    canonical_table: String(raw.canonical_table),
    canonical_metric: String(raw.canonical_metric),
    required_filters: asStringArray(raw.required_filters),
    exclusions: asStringArray(raw.exclusions),
    avoid_tables: asStringArray(raw.avoid_tables),
    aliases: asStringArray(raw.aliases),
    routing_triggers: asStringArray(raw.routing_triggers),
    owner: String(raw.owner),
    freshness_sla: String(raw.freshness_sla),
    related_teachings: asStringArray(raw.related_teachings),
    updated: String(raw.updated),
  };
}

function hasRequiredScalar(raw: Record<string, unknown>, field: RequiredScalarField): boolean {
  const value = raw[field];
  return value !== undefined && value !== null && !Array.isArray(value) && String(value).trim().length > 0;
}

function asStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [];
  return value.map(String);
}
