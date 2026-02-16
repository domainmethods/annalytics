import type { TableContext, TableQuality } from './types.js';

export function assessQuality(table: TableContext): TableQuality {
  const described = table.columns.filter((c) => c.description.trim().length > 0);
  const coverage = table.columns.length > 0 ? described.length / table.columns.length : 0;

  return {
    descriptionPresent: table.description.trim().length > 0,
    columnDescriptionCoverage: coverage,
    qualityTier: coverage > 0.7 ? 'high' : coverage >= 0.3 ? 'medium' : 'low',
  };
}
