import { GoogleGenAI } from '@google/genai';
import type { Teaching } from './types.js';
import { teachingToMarkdown } from './markdownConverter.js';

export interface SyncResult {
  uploaded: number;
  verified: number;
  active: number;
  deleted: number;
  errors: string[];
}

export interface FileSearchDocument {
  id: string;
  displayName: string;
  markdown: string;
}

interface UploadedDocumentTarget {
  displayName: string;
  documentName?: string;
}

export async function syncTeachingsToFileSearch(
  teachings: Teaching[],
  fileSearchStoreName: string,
  apiKey: string,
  options: SyncMarkdownDocumentsOptions = {},
): Promise<SyncResult> {
  return syncMarkdownDocumentsToFileSearch(
    teachings.map(teaching => ({
      id: teaching.id,
      displayName: `teaching:${teaching.id}`,
      markdown: teachingToMarkdown(teaching),
    })),
    fileSearchStoreName,
    apiKey,
    { ...options, deleteDisplayNamePrefix: 'teaching:' },
  );
}

export interface SyncMarkdownDocumentsOptions {
  deleteDisplayNamePrefix?: string;
  maxUploadAttempts?: number;
  uploadRetryBaseDelayMs?: number;
  operationPollAttempts?: number;
  operationPollIntervalMs?: number;
  maxIndexingAttempts?: number;
  activeDocumentPollAttempts?: number;
  activeDocumentPollIntervalMs?: number;
  cleanupPollAttempts?: number;
  cleanupPollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

type FileSearchUploadOperation = Awaited<
  ReturnType<GoogleGenAI['fileSearchStores']['uploadToFileSearchStore']>
>;

interface ResolvedSyncOptions {
  deleteDisplayNamePrefix?: string;
  maxUploadAttempts: number;
  uploadRetryBaseDelayMs: number;
  operationPollAttempts: number;
  operationPollIntervalMs: number;
  maxIndexingAttempts: number;
  activeDocumentPollAttempts: number;
  activeDocumentPollIntervalMs: number;
  cleanupPollAttempts: number;
  cleanupPollIntervalMs: number;
  sleep: (ms: number) => Promise<void>;
}

const transientStatusCodes = new Set(['429', '500', '503', '504']);
const transientStatuses = [
  'INTERNAL',
  'UNAVAILABLE',
  'DEADLINE_EXCEEDED',
  'RESOURCE_EXHAUSTED',
];

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resolveOptions(options: SyncMarkdownDocumentsOptions): ResolvedSyncOptions {
  return {
    deleteDisplayNamePrefix: options.deleteDisplayNamePrefix,
    maxUploadAttempts: options.maxUploadAttempts ?? 4,
    uploadRetryBaseDelayMs: options.uploadRetryBaseDelayMs ?? 1000,
    operationPollAttempts: options.operationPollAttempts ?? 20,
    operationPollIntervalMs: options.operationPollIntervalMs ?? 3000,
    maxIndexingAttempts: options.maxIndexingAttempts ?? 2,
    activeDocumentPollAttempts: options.activeDocumentPollAttempts ?? 20,
    activeDocumentPollIntervalMs: options.activeDocumentPollIntervalMs ?? 3000,
    cleanupPollAttempts: options.cleanupPollAttempts ?? 20,
    cleanupPollIntervalMs: options.cleanupPollIntervalMs ?? 3000,
    sleep: options.sleep ?? defaultSleep,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string =>
    typeof value === 'string' && value.length > 0,
  );
}

export function extractUploadedDocumentName(response: unknown): string | undefined {
  const record = asRecord(response);
  if (!record) return undefined;

  const nestedRecords = [
    asRecord(record.document),
    asRecord(record.fileSearchStoreDocument),
    asRecord(record.fileSearchDocument),
    asRecord(record.documentMetadata),
  ];

  return firstString(
    record.documentName,
    record.name,
    ...nestedRecords.flatMap(nested => [
      nested?.documentName,
      nested?.name,
    ]),
  );
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isTransientFileSearchError(err: unknown): boolean {
  const text = errorText(err).toUpperCase();
  const maybeRecord = typeof err === 'object' && err !== null
    ? err as Record<string, unknown>
    : {};
  const code = maybeRecord.code;
  const status = maybeRecord.status;

  if (code !== undefined && transientStatusCodes.has(String(code))) return true;
  if (typeof status === 'string' && transientStatuses.includes(status.toUpperCase())) return true;
  if (transientStatuses.some(value => text.includes(value))) return true;
  return /\b(429|500|503|504)\b/.test(text);
}

function operationErrorMessage(operation: FileSearchUploadOperation): string {
  const error = operation.error;
  if (!error) return 'unknown operation error';
  const message = error.message;
  if (typeof message === 'string' && message.length > 0) return message;
  return errorText(error);
}

function targetKey(target: UploadedDocumentTarget): string {
  return target.documentName ?? `displayName:${target.displayName}`;
}

function operationTarget(
  document: FileSearchDocument,
  operation: FileSearchUploadOperation,
): UploadedDocumentTarget {
  return {
    displayName: document.displayName,
    documentName: extractUploadedDocumentName(operation.response),
  };
}

interface FileSearchDocumentReadback {
  name?: string;
  displayName?: string;
  state: string;
}

async function listFileSearchDocuments(
  ai: GoogleGenAI,
  fileSearchStoreName: string,
): Promise<FileSearchDocumentReadback[]> {
  const documents = await ai.fileSearchStores.documents.list({
    parent: fileSearchStoreName,
  });
  const readback: FileSearchDocumentReadback[] = [];
  for await (const document of documents) {
    readback.push({
      name: document.name,
      displayName: document.displayName,
      state: document.state ?? 'STATE_UNSPECIFIED',
    });
  }
  return readback;
}

async function uploadWithRetry(
  ai: GoogleGenAI,
  fileSearchStoreName: string,
  document: FileSearchDocument,
  options: ResolvedSyncOptions,
): Promise<FileSearchUploadOperation> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxUploadAttempts; attempt++) {
    try {
      const file = new Blob([document.markdown], { type: 'text/markdown' });
      return await ai.fileSearchStores.uploadToFileSearchStore({
        fileSearchStoreName,
        file,
        config: {
          displayName: document.displayName,
          mimeType: 'text/markdown',
        },
      });
    } catch (err) {
      lastError = err;
      if (attempt >= options.maxUploadAttempts || !isTransientFileSearchError(err)) {
        throw err;
      }
      const delay = options.uploadRetryBaseDelayMs * 2 ** (attempt - 1);
      await options.sleep(delay);
    }
  }
  throw lastError;
}

async function waitForUploadOperation(
  ai: GoogleGenAI,
  operation: FileSearchUploadOperation,
  options: ResolvedSyncOptions,
): Promise<FileSearchUploadOperation> {
  let current = operation;
  for (let attempt = 1; attempt <= options.operationPollAttempts; attempt++) {
    if (current.error) {
      throw new Error(`Upload operation failed: ${operationErrorMessage(current)}`);
    }
    if (current.done || current.response) return current;
    if (!current.name) {
      throw new Error('Upload operation did not include a name for polling');
    }
    if (attempt < options.operationPollAttempts) {
      await options.sleep(options.operationPollIntervalMs);
      current = await ai.operations.get({ operation: current }) as FileSearchUploadOperation;
    }
  }
  throw new Error(`Upload operation did not complete after ${options.operationPollAttempts} polls`);
}

async function listDocumentStates(
  ai: GoogleGenAI,
  fileSearchStoreName: string,
  targets: UploadedDocumentTarget[],
): Promise<Map<string, string[]>> {
  const states = new Map<string, string[]>();
  const targetsByDocumentName = new Map(
    targets
      .filter(target => target.documentName)
      .map(target => [target.documentName, target]),
  );
  const fallbackTargetsByDisplayName = new Map(
    targets
      .filter(target => !target.documentName)
      .map(target => [target.displayName, target]),
  );
  const documents = await listFileSearchDocuments(ai, fileSearchStoreName);
  for (const document of documents) {
    const target = document.name
      ? targetsByDocumentName.get(document.name)
      : undefined;
    const fallbackTarget = document.displayName
      ? fallbackTargetsByDisplayName.get(document.displayName)
      : undefined;
    const matchedTarget = target ?? fallbackTarget;
    if (!matchedTarget) continue;
    const key = targetKey(matchedTarget);
    const existing = states.get(key) ?? [];
    existing.push(document.state ?? 'STATE_UNSPECIFIED');
    states.set(key, existing);
  }
  return states;
}

async function deleteDocumentsByTargets(
  ai: GoogleGenAI,
  fileSearchStoreName: string,
  targets: UploadedDocumentTarget[],
): Promise<void> {
  const fallbackDisplayNames = new Set(
    targets.filter(target => !target.documentName).map(target => target.displayName),
  );
  for (const target of targets) {
    if (!target.documentName) continue;
    try {
      await ai.fileSearchStores.documents.delete({
        name: target.documentName,
        config: { force: true },
      });
    } catch {
      // Best-effort retry cleanup; re-upload can still proceed if delete races.
    }
  }
  if (fallbackDisplayNames.size === 0) return;

  try {
    const documents = await listFileSearchDocuments(ai, fileSearchStoreName);
    for (const document of documents) {
      if (!document.name || !document.displayName) continue;
      if (!fallbackDisplayNames.has(document.displayName)) continue;
      try {
        await ai.fileSearchStores.documents.delete({
          name: document.name,
          config: { force: true },
        });
      } catch {
        // Best-effort retry cleanup; re-upload can still proceed if delete races.
      }
    }
  } catch {
    // Best-effort retry cleanup; re-upload can still proceed if listing is unavailable.
  }
}

async function verifyActiveDocuments(
  ai: GoogleGenAI,
  fileSearchStoreName: string,
  targets: UploadedDocumentTarget[],
  options: ResolvedSyncOptions,
): Promise<{
  active: UploadedDocumentTarget[];
  failed: UploadedDocumentTarget[];
  missing: UploadedDocumentTarget[];
}> {
  let activeKeys = new Set<string>();
  let failedKeys = new Set<string>();
  for (let attempt = 1; attempt <= options.activeDocumentPollAttempts; attempt++) {
    const states = await listDocumentStates(ai, fileSearchStoreName, targets);
    activeKeys = new Set();
    failedKeys = new Set();
    for (const target of targets) {
      const documentStates = states.get(targetKey(target)) ?? [];
      if (documentStates.includes('STATE_ACTIVE')) activeKeys.add(targetKey(target));
      if (documentStates.includes('STATE_FAILED')) failedKeys.add(targetKey(target));
    }
    if (activeKeys.size === targets.length) {
      return { active: targets, failed: [], missing: [] };
    }
    if (failedKeys.size > 0) {
      break;
    }
    if (attempt < options.activeDocumentPollAttempts) {
      await options.sleep(options.activeDocumentPollIntervalMs);
    }
  }

  return {
    active: targets.filter(target => activeKeys.has(targetKey(target))),
    failed: targets.filter(target => failedKeys.has(targetKey(target))),
    missing: targets.filter(target =>
      !activeKeys.has(targetKey(target)) && !failedKeys.has(targetKey(target)),
    ),
  };
}

function isManagedDocument(
  document: FileSearchDocumentReadback,
  displayNamePrefix?: string,
): boolean {
  if (!displayNamePrefix) return true;
  return Boolean(document.displayName?.startsWith(displayNamePrefix));
}

function retainedDocumentNames(
  documents: FileSearchDocumentReadback[],
  retainedTargets: UploadedDocumentTarget[],
): Set<string> {
  const retainedDocumentNames = new Set(
    retainedTargets
      .map(target => target.documentName)
      .filter((name): name is string => Boolean(name)),
  );

  for (const target of retainedTargets) {
    if (target.documentName) continue;
    const fallback = documents
      .filter(document =>
        document.displayName === target.displayName
        && document.state === 'STATE_ACTIVE'
        && document.name,
      )
      .sort((left, right) => left.name!.localeCompare(right.name!))
      .at(0);
    if (fallback?.name) retainedDocumentNames.add(fallback.name);
  }

  return retainedDocumentNames;
}

function documentsToDeleteForConvergence(
  documents: FileSearchDocumentReadback[],
  retainedTargets: UploadedDocumentTarget[],
  displayNamePrefix?: string,
): FileSearchDocumentReadback[] {
  const targetsByDisplayName = new Map(
    retainedTargets.map(target => [target.displayName, target]),
  );
  const retainedNames = retainedDocumentNames(documents, retainedTargets);

  return documents.filter(document => {
    if (!document.name) return false;
    if (!isManagedDocument(document, displayNamePrefix)) return false;
    const target = document.displayName
      ? targetsByDisplayName.get(document.displayName)
      : undefined;
    if (!target) return true;
    return !retainedNames.has(document.name);
  });
}

function convergenceStatus(
  documents: FileSearchDocumentReadback[],
  retainedTargets: UploadedDocumentTarget[],
  displayNamePrefix?: string,
): { active: number; issues: string[] } {
  const issues: string[] = [];
  const retainedNames = retainedDocumentNames(documents, retainedTargets);
  const targetsByDisplayName = new Map(
    retainedTargets.map(target => [target.displayName, target]),
  );
  let active = 0;

  for (const target of retainedTargets) {
    const matchingDocuments = documents.filter(document =>
      document.displayName === target.displayName,
    );
    const activeDocuments = matchingDocuments.filter(document =>
      document.state === 'STATE_ACTIVE',
    );
    const failedDocuments = matchingDocuments.filter(document =>
      document.state === 'STATE_FAILED',
    );
    const staleDocuments = matchingDocuments.filter(document =>
      !document.name || !retainedNames.has(document.name),
    );
    const uploadedActiveDocuments = target.documentName
      ? activeDocuments.filter(document => document.name === target.documentName)
      : activeDocuments;

    if (uploadedActiveDocuments.length === 1 && activeDocuments.length === 1) {
      active++;
    }
    if (uploadedActiveDocuments.length !== 1) {
      issues.push(`${target.displayName} missing uploaded STATE_ACTIVE document`);
    }
    if (activeDocuments.length > 1) {
      issues.push(`${target.displayName} has ${activeDocuments.length} active documents`);
    }
    if (failedDocuments.length > 0) {
      issues.push(`${target.displayName} has ${failedDocuments.length} failed documents`);
    }
    if (staleDocuments.length > 0) {
      issues.push(`${target.displayName} has ${staleDocuments.length} stale duplicate documents`);
    }
  }

  const extraManagedDocuments = documents.filter(document => {
    if (!isManagedDocument(document, displayNamePrefix)) return false;
    return !document.displayName || !targetsByDisplayName.has(document.displayName);
  });
  if (extraManagedDocuments.length > 0) {
    issues.push(`${extraManagedDocuments.length} unexpected managed documents remain`);
  }

  return { active, issues };
}

async function cleanupReplacedFiles(
  ai: GoogleGenAI,
  fileSearchStoreName: string,
  retainedTargets: UploadedDocumentTarget[],
  options: ResolvedSyncOptions,
): Promise<{ active: number; deleted: number; errors: string[] }> {
  let deleted = 0;
  let lastIssues: string[] = [];
  let lastActive = 0;
  let lastListError: unknown;

  for (let attempt = 1; attempt <= options.cleanupPollAttempts; attempt++) {
    let documents: FileSearchDocumentReadback[];
    try {
      documents = await listFileSearchDocuments(ai, fileSearchStoreName);
      lastListError = undefined;
    } catch (err) {
      lastListError = err;
      if (attempt < options.cleanupPollAttempts) {
        await options.sleep(options.cleanupPollIntervalMs);
        continue;
      }
      break;
    }

    const deletions = documentsToDeleteForConvergence(
      documents,
      retainedTargets,
      options.deleteDisplayNamePrefix,
    );
    for (const document of deletions) {
      if (!document.name) continue;
      try {
        await ai.fileSearchStores.documents.delete({
          name: document.name,
          config: { force: true },
        });
        deleted++;
      } catch {
        // Final convergence readback below determines whether cleanup succeeded.
      }
    }

    const status = convergenceStatus(
      documents,
      retainedTargets,
      options.deleteDisplayNamePrefix,
    );
    lastIssues = status.issues;
    lastActive = status.active;
    if (deletions.length === 0 && status.issues.length === 0) {
      return { active: status.active, deleted, errors: [] };
    }

    if (attempt < options.cleanupPollAttempts) {
      await options.sleep(options.cleanupPollIntervalMs);
    }
  }

  if (lastListError) {
    return {
      active: lastActive,
      deleted,
      errors: [`File Search cleanup failed: ${errorText(lastListError)}`],
    };
  }
  return {
    active: lastActive,
    deleted,
    errors: [
      `File Search cleanup did not converge: ${lastIssues.join('; ') || 'final readback was not duplicate-free'}`,
    ],
  };
}

export async function syncMarkdownDocumentsToFileSearch(
  documents: FileSearchDocument[],
  fileSearchStoreName: string,
  apiKey: string,
  options: SyncMarkdownDocumentsOptions = {},
): Promise<SyncResult> {
  const result: SyncResult = { uploaded: 0, verified: 0, active: 0, deleted: 0, errors: [] };
  if (documents.length === 0) return result;

  const resolvedOptions = resolveOptions(options);
  const ai = new GoogleGenAI({ apiKey });
  const uploadedTargets: UploadedDocumentTarget[] = [];
  const documentsByDisplayName = new Map(
    documents.map(document => [document.displayName, document]),
  );

  for (const document of documents) {
    try {
      const operation = await uploadWithRetry(ai, fileSearchStoreName, document, resolvedOptions);
      const completedOperation = await waitForUploadOperation(ai, operation, resolvedOptions);

      result.uploaded++;
      uploadedTargets.push(operationTarget(document, completedOperation));
    } catch (err) {
      result.errors.push(`${document.id}: ${errorText(err)}`);
    }
  }

  let pendingVerification = uploadedTargets;
  const verifiedTargets = new Map<string, UploadedDocumentTarget>();
  for (
    let indexingAttempt = 1;
    pendingVerification.length > 0 && indexingAttempt <= resolvedOptions.maxIndexingAttempts;
    indexingAttempt++
  ) {
    let verification: Awaited<ReturnType<typeof verifyActiveDocuments>>;
    try {
      verification = await verifyActiveDocuments(
        ai,
        fileSearchStoreName,
        pendingVerification,
        resolvedOptions,
      );
    } catch (err) {
      result.errors.push(`File Search verification failed: ${errorText(err)}`);
      break;
    }

    for (const target of verification.active) {
      verifiedTargets.set(targetKey(target), target);
    }
    pendingVerification = [...verification.missing, ...verification.failed];
    if (pendingVerification.length === 0) break;

    if (indexingAttempt >= resolvedOptions.maxIndexingAttempts) {
      result.errors.push(
        `File Search verification failed: ${
          pendingVerification.map(target => target.displayName).join(', ')
        } not STATE_ACTIVE`,
      );
      break;
    }

    if (verification.failed.length > 0) {
      await deleteDocumentsByTargets(ai, fileSearchStoreName, verification.failed);
    }
    const retryPending: UploadedDocumentTarget[] = [];
    for (const target of verification.failed) {
      const document = documentsByDisplayName.get(target.displayName);
      if (!document) continue;
      try {
        const operation = await uploadWithRetry(ai, fileSearchStoreName, document, resolvedOptions);
        const completedOperation = await waitForUploadOperation(ai, operation, resolvedOptions);
        retryPending.push(operationTarget(document, completedOperation));
      } catch (err) {
        result.errors.push(`${document.id}: ${errorText(err)}`);
      }
    }
    pendingVerification = [...verification.missing, ...retryPending];
  }
  result.verified = new Set(
    [...verifiedTargets.values()].map(target => target.displayName),
  ).size;
  result.active = result.verified;

  if (result.errors.length === 0 && result.verified === documents.length) {
    const cleanup = await cleanupReplacedFiles(
      ai,
      fileSearchStoreName,
      [...verifiedTargets.values()],
      resolvedOptions,
    );
    result.active = cleanup.active;
    result.deleted = cleanup.deleted;
    result.errors.push(...cleanup.errors);
  }

  return result;
}
