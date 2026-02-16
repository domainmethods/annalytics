import { GoogleGenAI } from '@google/genai';
import type { Teaching } from './types.js';
import { teachingToMarkdown } from './markdownConverter.js';

export interface SyncResult {
  uploaded: number;
  deleted: number;
  errors: string[];
}

async function clearExistingFiles(
  ai: GoogleGenAI,
  fileSearchStoreName: string,
): Promise<number> {
  let deleted = 0;
  try {
    // Use the File Search Stores API to list and delete existing files
    const stores = ai.fileSearchStores as any;
    const files = await stores.listFileSearchStoreFiles({ fileSearchStoreName });
    if (files && Array.isArray(files)) {
      for (const file of files) {
        try {
          await stores.deleteFileSearchStoreFile({
            fileSearchStoreName,
            fileSearchStoreFileName: file.name,
          });
          deleted++;
        } catch {
          // Best-effort cleanup — continue on individual file deletion failure
        }
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
  const result: SyncResult = { uploaded: 0, deleted: 0, errors: [] };
  if (teachings.length === 0) return result;

  const ai = new GoogleGenAI({ apiKey });

  // Clear previous contents before uploading
  result.deleted = await clearExistingFiles(ai, fileSearchStoreName);

  for (const teaching of teachings) {
    try {
      const markdown = teachingToMarkdown(teaching);
      const file = new Blob([markdown], { type: 'text/markdown' });

      await ai.fileSearchStores.uploadToFileSearchStore({
        fileSearchStoreName,
        file,
        config: {
          displayName: teaching.id,
        },
      });

      result.uploaded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${teaching.id}: ${msg}`);
    }
  }

  return result;
}
