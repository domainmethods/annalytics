export type ReferencedTable = { projectId?: string; datasetId?: string; tableId?: string };
export type QueryRelationMetadata = {
  referencedTables?: ReferencedTable[];
  referencedLogicalViews?: ReferencedTable[];
  referencedRoutines?: { projectId?: string; datasetId?: string; routineId?: string }[];
};

/** Copies only the relation fields that are present. Firestore rejects `undefined` values. */
export function pickRelationMetadata(
  { referencedTables, referencedLogicalViews, referencedRoutines }: QueryRelationMetadata,
): QueryRelationMetadata {
  return {
    ...(referencedTables && { referencedTables }),
    ...(referencedLogicalViews && { referencedLogicalViews }),
    ...(referencedRoutines && { referencedRoutines }),
  };
}
