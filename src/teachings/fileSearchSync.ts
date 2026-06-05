import { GoogleGenAI } from '@google/genai';
import type { Teaching } from './types.js';
import { teachingToMarkdown } from './markdownConverter.js';

export interface SyncResult {
  uploaded: number;
  verified: number;
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
): Promise<SyncResult> {
  return syncMarkdownDocumentsToFileSearch(
    teachings.map(teaching => ({
      id: teaching.id,
      displayName: `teaching:${teaching.id}`,
      markdown: teachingToMarkdown(teaching),
    })),
    fileSearchStoreName,
    apiKey,
    { deleteDisplayNamePrefix: 'teaching:' },
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
    sleep: options.sleep ?? defaultSleep,
  };
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
    documentName: operation.response?.documentName,
  };
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
  const documents = await ai.fileSearchStores.documents.list({
    parent: fileSearchStoreName,
  });
  for await (const document of documents) {
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
    const documents = await ai.fileSearchStores.documents.list({
      parent: fileSearchStoreName,
    });
    for await (const document of documents) {
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
): Promise<{ active: UploadedDocumentTarget[]; missing: UploadedDocumentTarget[] }> {
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
      return { active: targets, missing: [] };
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
    missing: targets.filter(target => !activeKeys.has(targetKey(target))),
  };
}

async function cleanupReplacedFiles(
  ai: GoogleGenAI,
  fileSearchStoreName: string,
  retainedTargets: UploadedDocumentTarget[],
  displayNamePrefix?: string,
): Promise<number> {
  let deleted = 0;
  const retainedDocumentNames = new Set(
    retainedTargets
      .map(target => target.documentName)
      .filter((name): name is string => Boolean(name)),
  );
  const fallbackDisplayNames = new Set(
    retainedTargets
      .filter(target => !target.documentName)
      .map(target => target.displayName),
  );

  try {
    const documents = await ai.fileSearchStores.documents.list({
      parent: fileSearchStoreName,
    });
    for await (const document of documents) {
      if (!document.name) continue;
      if (displayNamePrefix && !document.displayName?.startsWith(displayNamePrefix)) continue;
      if (retainedDocumentNames.has(document.name)) continue;
      if (document.displayName && fallbackDisplayNames.has(document.displayName)) continue;
      try {
        await ai.fileSearchStores.documents.delete({
          name: document.name,
          config: { force: true },
        });
        deleted++;
      } catch {
        // Best-effort cleanup; verified new documents remain available.
      }
    }
  } catch {
    // Best-effort cleanup; verified new documents remain available.
  }

  return deleted;
}

export async function syncMarkdownDocumentsToFileSearch(
  documents: FileSearchDocument[],
  fileSearchStoreName: string,
  apiKey: string,
  options: SyncMarkdownDocumentsOptions = {},
): Promise<SyncResult> {
  const result: SyncResult = { uploaded: 0, verified: 0, deleted: 0, errors: [] };
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
    pendingVerification = verification.missing;
    if (pendingVerification.length === 0) break;

    if (indexingAttempt >= resolvedOptions.maxIndexingAttempts) {
      result.errors.push(
        `File Search verification failed: ${
          pendingVerification.map(target => target.displayName).join(', ')
        } not STATE_ACTIVE`,
      );
      break;
    }

    await deleteDocumentsByTargets(ai, fileSearchStoreName, pendingVerification);
    const retryPending: UploadedDocumentTarget[] = [];
    for (const target of pendingVerification) {
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
    pendingVerification = retryPending;
  }
  result.verified = new Set(
    [...verifiedTargets.values()].map(target => target.displayName),
  ).size;

  if (result.errors.length === 0 && result.verified === documents.length) {
    result.deleted = await cleanupReplacedFiles(
      ai,
      fileSearchStoreName,
      [...verifiedTargets.values()],
      resolvedOptions.deleteDisplayNamePrefix,
    );
  }

  return result;
}
