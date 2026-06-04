export interface ReferenceCard {
  id: string;
  title: string;
  domain: string;
  grain: string;
  canonical_table: string;
  canonical_metric: string;
  required_filters: string[];
  exclusions: string[];
  avoid_tables: string[];
  aliases: string[];
  routing_triggers: string[];
  owner: string;
  freshness_sla: string;
  related_teachings: string[];
  updated: string;
}

export interface ReferenceCardFile {
  reference_cards: ReferenceCard[];
}
