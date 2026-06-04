import type { ReferenceCard } from './types.js';

export interface ReferenceCardIntegrityOptions {
  allowedDomains?: Set<string>;
  validTableNames?: Set<string>;
  validTeachingIds?: Set<string>;
}

export function validateReferenceCardIntegrity(
  cards: ReferenceCard[],
  options: ReferenceCardIntegrityOptions = {},
): string[] {
  const errors: string[] = [];
  const seenIds = new Set<string>();

  for (const card of cards) {
    if (seenIds.has(card.id)) {
      errors.push(`Duplicate reference card id: ${card.id}`);
    }
    seenIds.add(card.id);

    validateRequiredStrings(card, errors);
    validateAliases(card, errors);
    validateRoutingTriggers(card, errors);
    validateUpdated(card, errors);
    validateDomain(card, options, errors);
    validateTables(card, options, errors);
    validateRelatedTeachings(card, options, errors);
  }

  return errors;
}

export function validateReferenceCards(
  cards: ReferenceCard[],
  options: ReferenceCardIntegrityOptions = {},
): string[] {
  return validateReferenceCardIntegrity(cards, options);
}

function validateRequiredStrings(card: ReferenceCard, errors: string[]): void {
  const fields: Array<keyof Pick<
    ReferenceCard,
    'id' | 'title' | 'domain' | 'grain' | 'canonical_table' | 'canonical_metric' | 'owner' | 'freshness_sla' | 'updated'
  >> = [
    'id',
    'title',
    'domain',
    'grain',
    'canonical_table',
    'canonical_metric',
    'owner',
    'freshness_sla',
    'updated',
  ];

  for (const field of fields) {
    if (card[field].trim().length === 0) {
      errors.push(`Reference card ${card.id} is missing required field: ${field}`);
    }
  }
}

function validateAliases(card: ReferenceCard, errors: string[]): void {
  if (card.aliases.length === 0) {
    errors.push(`Reference card ${card.id} must include at least one alias`);
  }

  for (const alias of card.aliases) {
    if (alias.trim().length === 0) {
      errors.push(`Reference card ${card.id} includes an empty alias`);
    }
  }
}

function validateRoutingTriggers(card: ReferenceCard, errors: string[]): void {
  if (card.routing_triggers.length === 0) {
    errors.push(`Reference card ${card.id} must include at least one routing trigger`);
  }

  for (const trigger of card.routing_triggers) {
    if (trigger.trim().length === 0) {
      errors.push(`Reference card ${card.id} includes an empty routing trigger`);
    }
  }
}

function validateUpdated(card: ReferenceCard, errors: string[]): void {
  if (!isValidIsoDate(card.updated)) {
    errors.push(`Reference card ${card.id} has invalid or missing updated date: ${card.updated}`);
  }
}

function validateDomain(
  card: ReferenceCard,
  options: ReferenceCardIntegrityOptions,
  errors: string[],
): void {
  if (options.allowedDomains && !options.allowedDomains.has(card.domain)) {
    errors.push(`Reference card ${card.id} has unsupported domain: ${card.domain}`);
  }
}

function validateTables(
  card: ReferenceCard,
  options: ReferenceCardIntegrityOptions,
  errors: string[],
): void {
  if (!options.validTableNames) return;

  if (!options.validTableNames.has(card.canonical_table)) {
    errors.push(`Reference card ${card.id} references unknown canonical table: ${card.canonical_table}`);
  }

  for (const table of card.avoid_tables) {
    if (!options.validTableNames.has(table)) {
      errors.push(`Reference card ${card.id} references unknown avoid table: ${table}`);
    }
  }
}

function validateRelatedTeachings(
  card: ReferenceCard,
  options: ReferenceCardIntegrityOptions,
  errors: string[],
): void {
  if (!options.validTeachingIds) return;

  for (const teachingId of card.related_teachings) {
    if (!options.validTeachingIds.has(teachingId)) {
      errors.push(`Reference card ${card.id} references unknown related teaching: ${teachingId}`);
    }
  }
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
