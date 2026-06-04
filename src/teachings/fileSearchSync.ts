import { GoogleGenAI } from '@google/genai';
import type { Teaching } from './types.js';
import { teachingToMarkdown } from './markdownConverter.js';

export interface SyncResult {
  uploaded: number;
  deleted: number;
  errors: string[];
}

export interface FileSearchDocument {
  id: string;
  displayName: string;
  markdown: string;
}

async function clearExistingFiles(
  ai: GoogleGenAI,
  fileSearchStoreName: string,
  displayNamePrefix?: string,
): Promise<number> {
  let deleted = 0;
  try {
    const documents = await ai.fileSearchStores.documents.list({
      parent: fileSearchStoreName,
    });
    for await (const document of documents) {
      if (!document.name) continue;
      if (displayNamePrefix && !document.displayName?.startsWith(displayNamePrefix)) continue;
      try {
        await ai.fileSearchStores.documents.delete({
          name: document.name,
          config: { force: true },
        });
        deleted++;
      } catch {
        // Best-effort cleanup — continue on individual document deletion failure
      }
    }
  } catch {
    // If listing/deletion fails, proceed with upload (may cause duplicates until API support lands)
  }
  return deleted;
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
}

export async function syncMarkdownDocumentsToFileSearch(
  documents: FileSearchDocument[],
  fileSearchStoreName: string,
  apiKey: string,
  options: SyncMarkdownDocumentsOptions = {},
): Promise<SyncResult> {
  const result: SyncResult = { uploaded: 0, deleted: 0, errors: [] };
  if (documents.length === 0) return result;

  const ai = new GoogleGenAI({ apiKey });

  // Clear previous contents before uploading
  result.deleted = await clearExistingFiles(
    ai,
    fileSearchStoreName,
    options.deleteDisplayNamePrefix,
  );

  for (const document of documents) {
    try {
      const file = new Blob([document.markdown], { type: 'text/markdown' });

      await ai.fileSearchStores.uploadToFileSearchStore({
        fileSearchStoreName,
        file,
        config: {
          displayName: document.displayName,
        },
      });

      result.uploaded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${document.id}: ${msg}`);
    }
  }

  return result;
}
