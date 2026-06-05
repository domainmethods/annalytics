import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  extractUploadedDocumentName,
  syncMarkdownDocumentsToFileSearch,
  syncTeachingsToFileSearch,
} from '../../src/teachings/fileSearchSync.js';
import type { Teaching } from '../../src/teachings/types.js';

const mockUpload = vi.fn();
const mockGetOperation = vi.fn();
const mockListDocuments = vi.fn();
const mockDeleteDocument = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function () {
    return {
      operations: {
        get: mockGetOperation,
      },
      fileSearchStores: {
        uploadToFileSearchStore: mockUpload,
        documents: {
          list: mockListDocuments,
          delete: mockDeleteDocument,
        },
      },
    };
  }),
}));

vi.mock('../../src/teachings/markdownConverter.js', () => ({
  teachingToMarkdown: (t: Teaching) => `# Teaching: ${t.id}`,
}));

const teaching1: Teaching = {
  id: 'revenue-monthly',
  question_patterns: ['monthly revenue'],
  sanctioned_sql: 'SELECT 1',
  reasoning: 'Revenue reasoning.',
  models_referenced: ['analytics.fct_orders'],
  tags: ['revenue'],
  author: 'test',
  updated: '2026-02-10',
};

const teaching2: Teaching = {
  id: 'churn-definition',
  question_patterns: ['churn'],
  sanctioned_sql: null,
  reasoning: 'Churn reasoning.',
  models_referenced: ['analytics.dim_customers'],
  tags: ['churn'],
  author: 'test',
  updated: '2026-02-10',
};

let uploadedDisplayNames: string[];

function activeDocument(displayName: string) {
  return {
    name: `stores/test/documents/${displayName.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`,
    displayName,
    state: 'STATE_ACTIVE',
  };
}

function syncTestOptions() {
  return {
    uploadRetryBaseDelayMs: 0,
    operationPollIntervalMs: 0,
    activeDocumentPollIntervalMs: 0,
    cleanupPollIntervalMs: 0,
    sleep: vi.fn(),
  };
}

describe('extractUploadedDocumentName', () => {
  it('extracts direct and nested document names from SDK response shapes', () => {
    expect(extractUploadedDocumentName({
      documentName: 'stores/test/documents/direct-document-name',
    })).toBe('stores/test/documents/direct-document-name');

    expect(extractUploadedDocumentName({
      name: 'stores/test/documents/direct-name',
    })).toBe('stores/test/documents/direct-name');

    expect(extractUploadedDocumentName({
      document: { name: 'stores/test/documents/nested-document-name' },
    })).toBe('stores/test/documents/nested-document-name');

    expect(extractUploadedDocumentName({
      fileSearchStoreDocument: {
        documentName: 'stores/test/documents/nested-file-search-document-name',
      },
    })).toBe('stores/test/documents/nested-file-search-document-name');
  });
});

describe('syncTeachingsToFileSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uploadedDisplayNames = [];
    mockUpload.mockImplementation(async (params) => {
      uploadedDisplayNames.push(params.config.displayName);
      return {
        name: `operations/${params.config.displayName}`,
        done: true,
        response: { documentName: activeDocument(params.config.displayName).name },
      };
    });
    mockGetOperation.mockResolvedValue({ name: 'op-1', done: true });
    mockListDocuments.mockImplementation(async () => uploadedDisplayNames.map(activeDocument));
    mockDeleteDocument.mockResolvedValue({});
  });

  it('uploads each teaching as a separate file to the store', async () => {
    const result = await syncTeachingsToFileSearch(
      [teaching1, teaching2], 'stores/test', 'key',
    );

    expect(result.uploaded).toBe(2);
    expect(result.verified).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(mockUpload).toHaveBeenCalledTimes(2);
  });

  it('sets displayName to namespaced teaching ID', async () => {
    await syncTeachingsToFileSearch([teaching1], 'stores/test', 'key');

    expect(mockUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        fileSearchStoreName: 'stores/test',
        config: expect.objectContaining({
          displayName: 'teaching:revenue-monthly',
          mimeType: 'text/markdown',
        }),
      }),
    );
  });

  it('uploads generic markdown documents with explicit display names', async () => {
    const result = await syncMarkdownDocumentsToFileSearch([
      {
        id: 'revenue-canonical-definition',
        displayName: 'reference_card:revenue-canonical-definition',
        markdown: '# ReferenceCard: revenue-canonical-definition',
      },
    ], 'stores/test', 'key');

    expect(result.uploaded).toBe(1);
    expect(result.verified).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(mockUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        fileSearchStoreName: 'stores/test',
        config: expect.objectContaining({
          displayName: 'reference_card:revenue-canonical-definition',
          mimeType: 'text/markdown',
        }),
      }),
    );
  });

  it('cleans up replaced File Search documents after new upload is verified', async () => {
    const newDocument = activeDocument('reference_card:revenue-canonical-definition');
    mockListDocuments
      .mockResolvedValueOnce([newDocument])
      .mockResolvedValueOnce([
        { name: 'stores/test/documents/old-1' },
        { name: 'stores/test/documents/old-2' },
        newDocument,
      ])
      .mockImplementation(async () => uploadedDisplayNames.map(activeDocument));

    const result = await syncMarkdownDocumentsToFileSearch([
      {
        id: 'revenue-canonical-definition',
        displayName: 'reference_card:revenue-canonical-definition',
        markdown: '# ReferenceCard: revenue-canonical-definition',
      },
    ], 'stores/test', 'key', syncTestOptions());

    expect(result.deleted).toBe(2);
    expect(result.active).toBe(1);
    expect(mockListDocuments).toHaveBeenCalledWith({ parent: 'stores/test' });
    expect(mockDeleteDocument).toHaveBeenCalledWith({
      name: 'stores/test/documents/old-1',
      config: { force: true },
    });
    expect(mockDeleteDocument).toHaveBeenCalledWith({
      name: 'stores/test/documents/old-2',
      config: { force: true },
    });
    expect(result.verified).toBe(1);
  });

  it('teaching-only sync preserves reference-card documents in the shared store', async () => {
    const newTeachingDocument = activeDocument('teaching:revenue-monthly');
    mockListDocuments
      .mockResolvedValueOnce([newTeachingDocument])
      .mockResolvedValueOnce([
        {
          name: 'stores/test/documents/teaching-old',
          displayName: 'teaching:old-revenue',
        },
        {
          name: 'stores/test/documents/reference-card',
          displayName: 'reference_card:revenue-canonical-definition',
        },
        newTeachingDocument,
      ])
      .mockImplementation(async () => uploadedDisplayNames.map(activeDocument));

    const result = await syncTeachingsToFileSearch([teaching1], 'stores/test', 'key', syncTestOptions());

    expect(result.deleted).toBe(1);
    expect(mockDeleteDocument).toHaveBeenCalledTimes(1);
    expect(mockDeleteDocument).toHaveBeenCalledWith({
      name: 'stores/test/documents/teaching-old',
      config: { force: true },
    });
  });

  it('handles empty teachings array without error', async () => {
    const result = await syncTeachingsToFileSearch([], 'stores/test', 'key');

    expect(result.uploaded).toBe(0);
    expect(result.verified).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('collects errors per teaching without aborting sync', async () => {
    mockUpload
      .mockImplementationOnce(async (params) => {
        uploadedDisplayNames.push(params.config.displayName);
        return { name: 'op-1', done: true };
      })
      .mockRejectedValueOnce(new Error('Upload failed'));

    const result = await syncTeachingsToFileSearch(
      [teaching1, teaching2], 'stores/test', 'key',
    );

    expect(result.uploaded).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('churn-definition');
    expect(result.errors[0]).toContain('Upload failed');
  });

  it('retries transient upload failures before recording success', async () => {
    mockUpload
      .mockRejectedValueOnce(new Error('{"error":{"code":500,"status":"INTERNAL"}}'))
      .mockRejectedValueOnce(new Error('temporary 503 UNAVAILABLE'))
      .mockImplementationOnce(async (params) => {
        uploadedDisplayNames.push(params.config.displayName);
        return { name: 'op-1', done: true };
      });

    const result = await syncMarkdownDocumentsToFileSearch([
      {
        id: 'revenue-canonical-definition',
        displayName: 'reference_card:revenue-canonical-definition',
        markdown: '# ReferenceCard: revenue-canonical-definition',
      },
    ], 'stores/test', 'key', syncTestOptions());

    expect(result.uploaded).toBe(1);
    expect(result.verified).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(mockUpload).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-transient upload failures', async () => {
    mockUpload.mockRejectedValueOnce(new Error('{"error":{"code":400,"status":"INVALID_ARGUMENT"}}'));

    const result = await syncMarkdownDocumentsToFileSearch([
      {
        id: 'revenue-canonical-definition',
        displayName: 'reference_card:revenue-canonical-definition',
        markdown: '# ReferenceCard: revenue-canonical-definition',
      },
    ], 'stores/test', 'key', syncTestOptions());

    expect(result.uploaded).toBe(0);
    expect(result.verified).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('INVALID_ARGUMENT');
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  it('does not clean up existing documents when upload errors remain', async () => {
    mockUpload.mockRejectedValue(new Error('{"error":{"code":500,"status":"INTERNAL"}}'));

    const result = await syncMarkdownDocumentsToFileSearch([
      {
        id: 'revenue-canonical-definition',
        displayName: 'reference_card:revenue-canonical-definition',
        markdown: '# ReferenceCard: revenue-canonical-definition',
      },
    ], 'stores/test', 'key', syncTestOptions());

    expect(result.uploaded).toBe(0);
    expect(result.verified).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(mockDeleteDocument).not.toHaveBeenCalled();
  });

  it('polls unfinished upload operations until completion', async () => {
    mockUpload.mockImplementationOnce(async (params) => {
      uploadedDisplayNames.push(params.config.displayName);
      return { name: 'operations/upload-1', done: false };
    });
    mockGetOperation.mockResolvedValueOnce({ name: 'operations/upload-1', done: true });

    const result = await syncMarkdownDocumentsToFileSearch([
      {
        id: 'revenue-canonical-definition',
        displayName: 'reference_card:revenue-canonical-definition',
        markdown: '# ReferenceCard: revenue-canonical-definition',
      },
    ], 'stores/test', 'key', syncTestOptions());

    expect(result.uploaded).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(mockGetOperation).toHaveBeenCalledWith({
      operation: expect.objectContaining({ name: 'operations/upload-1' }),
    });
  });

  it('treats upload operations with a response as complete even when done is omitted', async () => {
    mockUpload.mockImplementationOnce(async (params) => {
      uploadedDisplayNames.push(params.config.displayName);
      return { name: 'operations/upload-1', response: {} };
    });

    const result = await syncMarkdownDocumentsToFileSearch([
      {
        id: 'revenue-canonical-definition',
        displayName: 'reference_card:revenue-canonical-definition',
        markdown: '# ReferenceCard: revenue-canonical-definition',
      },
    ], 'stores/test', 'key', syncTestOptions());

    expect(result.uploaded).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(mockGetOperation).not.toHaveBeenCalled();
  });

  it('records operation errors as document sync errors', async () => {
    mockUpload.mockImplementationOnce(async (params) => {
      uploadedDisplayNames.push(params.config.displayName);
      return { name: 'operations/upload-1', done: false };
    });
    mockGetOperation.mockResolvedValueOnce({
      name: 'operations/upload-1',
      done: true,
      error: { code: 500, message: 'indexing failed' },
    });

    const result = await syncMarkdownDocumentsToFileSearch([
      {
        id: 'revenue-canonical-definition',
        displayName: 'reference_card:revenue-canonical-definition',
        markdown: '# ReferenceCard: revenue-canonical-definition',
      },
    ], 'stores/test', 'key', syncTestOptions());

    expect(result.uploaded).toBe(0);
    expect(result.verified).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('revenue-canonical-definition');
    expect(result.errors[0]).toContain('indexing failed');
  });

  it('records a verification error when uploaded documents are not active', async () => {
    mockListDocuments
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        {
          name: 'stores/test/documents/reference-card',
          displayName: 'reference_card:revenue-canonical-definition',
          state: 'STATE_PROCESSING',
        },
      ]);

    const result = await syncMarkdownDocumentsToFileSearch([
      {
        id: 'revenue-canonical-definition',
        displayName: 'reference_card:revenue-canonical-definition',
        markdown: '# ReferenceCard: revenue-canonical-definition',
      },
    ], 'stores/test', 'key', {
      ...syncTestOptions(),
      activeDocumentPollAttempts: 2,
      maxIndexingAttempts: 1,
    });

    expect(result.uploaded).toBe(1);
    expect(result.verified).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('File Search verification failed');
    expect(result.errors[0]).toContain('reference_card:revenue-canonical-definition');
    expect(mockDeleteDocument).not.toHaveBeenCalled();
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  it('does not let an older active duplicate satisfy a named new upload', async () => {
    const newDocumentName = 'stores/test/documents/new-reference-card';
    const oldActiveDuplicate = {
      name: 'stores/test/documents/old-reference-card',
      displayName: 'reference_card:revenue-canonical-definition',
      state: 'STATE_ACTIVE',
    };
    mockUpload.mockImplementationOnce(async (params) => {
      uploadedDisplayNames.push(params.config.displayName);
      return {
        name: 'operations/upload-new-reference-card',
        response: { documentName: newDocumentName },
      };
    });
    mockListDocuments.mockResolvedValue([oldActiveDuplicate]);

    const result = await syncMarkdownDocumentsToFileSearch([
      {
        id: 'revenue-canonical-definition',
        displayName: 'reference_card:revenue-canonical-definition',
        markdown: '# ReferenceCard: revenue-canonical-definition',
      },
    ], 'stores/test', 'key', {
      ...syncTestOptions(),
      activeDocumentPollAttempts: 1,
      maxIndexingAttempts: 1,
    });

    expect(result.uploaded).toBe(1);
    expect(result.verified).toBe(0);
    expect(result.active).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('not STATE_ACTIVE');
    expect(mockDeleteDocument).not.toHaveBeenCalled();
  });

  it('does not delete or reupload documents that time out without STATE_FAILED', async () => {
    const processingDocument = {
      name: 'stores/test/documents/processing-reference-card',
      displayName: 'reference_card:revenue-canonical-definition',
      state: 'STATE_PROCESSING',
    };
    mockUpload.mockImplementationOnce(async (params) => {
      uploadedDisplayNames.push(params.config.displayName);
      return {
        name: 'operations/upload-processing',
        response: { documentName: processingDocument.name },
      };
    });
    mockListDocuments.mockResolvedValue([processingDocument]);

    const result = await syncMarkdownDocumentsToFileSearch([
      {
        id: 'revenue-canonical-definition',
        displayName: 'reference_card:revenue-canonical-definition',
        markdown: '# ReferenceCard: revenue-canonical-definition',
      },
    ], 'stores/test', 'key', {
      ...syncTestOptions(),
      activeDocumentPollAttempts: 1,
      maxIndexingAttempts: 2,
    });

    expect(result.uploaded).toBe(1);
    expect(result.verified).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('not STATE_ACTIVE');
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockDeleteDocument).not.toHaveBeenCalled();
  });

  it('reuploads documents that reach STATE_FAILED during active readback', async () => {
    const failedDocument = {
      name: 'stores/test/documents/failed-reference-card',
      displayName: 'reference_card:revenue-canonical-definition',
      state: 'STATE_FAILED',
    };
    const activeRetryDocument = activeDocument('reference_card:revenue-canonical-definition');
    mockUpload
      .mockImplementationOnce(async (params) => {
        uploadedDisplayNames.push(params.config.displayName);
        return {
          name: 'operations/upload-failed-index',
          response: { documentName: failedDocument.name },
        };
      })
      .mockImplementationOnce(async (params) => {
        uploadedDisplayNames.push(params.config.displayName);
        return {
          name: 'operations/upload-active-index',
          response: { documentName: activeRetryDocument.name },
        };
      });
    mockListDocuments
      .mockResolvedValueOnce([failedDocument])
      .mockResolvedValue([activeRetryDocument]);

    const result = await syncMarkdownDocumentsToFileSearch([
      {
        id: 'revenue-canonical-definition',
        displayName: 'reference_card:revenue-canonical-definition',
        markdown: '# ReferenceCard: revenue-canonical-definition',
      },
    ], 'stores/test', 'key', syncTestOptions());

    expect(result.uploaded).toBe(1);
    expect(result.verified).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(mockUpload).toHaveBeenCalledTimes(2);
    expect(mockDeleteDocument).toHaveBeenCalledWith({
      name: 'stores/test/documents/failed-reference-card',
      config: { force: true },
    });
  });

  it('deletes old active duplicates and failed documents after the new upload is active', async () => {
    const newDocument = {
      name: 'stores/test/documents/new-reference-card',
      displayName: 'reference_card:revenue-canonical-definition',
      state: 'STATE_ACTIVE',
    };
    const oldDuplicate = {
      name: 'stores/test/documents/old-reference-card',
      displayName: 'reference_card:revenue-canonical-definition',
      state: 'STATE_ACTIVE',
    };
    const failedDuplicate = {
      name: 'stores/test/documents/failed-reference-card',
      displayName: 'reference_card:revenue-canonical-definition',
      state: 'STATE_FAILED',
    };
    mockUpload.mockImplementationOnce(async (params) => {
      uploadedDisplayNames.push(params.config.displayName);
      return {
        name: 'operations/upload-new-reference-card',
        response: { documentName: newDocument.name },
      };
    });
    mockListDocuments
      .mockResolvedValueOnce([newDocument])
      .mockResolvedValueOnce([newDocument, oldDuplicate, failedDuplicate])
      .mockResolvedValue([newDocument]);

    const result = await syncMarkdownDocumentsToFileSearch([
      {
        id: 'revenue-canonical-definition',
        displayName: 'reference_card:revenue-canonical-definition',
        markdown: '# ReferenceCard: revenue-canonical-definition',
      },
    ], 'stores/test', 'key', syncTestOptions());

    expect(result.uploaded).toBe(1);
    expect(result.verified).toBe(1);
    expect(result.active).toBe(1);
    expect(result.deleted).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(mockDeleteDocument).toHaveBeenCalledWith({
      name: oldDuplicate.name,
      config: { force: true },
    });
    expect(mockDeleteDocument).toHaveBeenCalledWith({
      name: failedDuplicate.name,
      config: { force: true },
    });
  });

  it('polls cleanup until duplicate deletion disappears from readback', async () => {
    const sleep = vi.fn();
    const newDocument = {
      name: 'stores/test/documents/new-reference-card',
      displayName: 'reference_card:revenue-canonical-definition',
      state: 'STATE_ACTIVE',
    };
    const oldDuplicate = {
      name: 'stores/test/documents/old-reference-card',
      displayName: 'reference_card:revenue-canonical-definition',
      state: 'STATE_ACTIVE',
    };
    mockUpload.mockImplementationOnce(async (params) => {
      uploadedDisplayNames.push(params.config.displayName);
      return {
        name: 'operations/upload-new-reference-card',
        response: { document: { name: newDocument.name } },
      };
    });
    mockListDocuments
      .mockResolvedValueOnce([newDocument])
      .mockResolvedValueOnce([newDocument, oldDuplicate])
      .mockResolvedValueOnce([newDocument, oldDuplicate])
      .mockResolvedValue([newDocument]);

    const result = await syncMarkdownDocumentsToFileSearch([
      {
        id: 'revenue-canonical-definition',
        displayName: 'reference_card:revenue-canonical-definition',
        markdown: '# ReferenceCard: revenue-canonical-definition',
      },
    ], 'stores/test', 'key', {
      ...syncTestOptions(),
      cleanupPollAttempts: 3,
      sleep,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.active).toBe(1);
    expect(mockDeleteDocument).toHaveBeenCalledWith({
      name: oldDuplicate.name,
      config: { force: true },
    });
    expect(sleep).toHaveBeenCalled();
    expect(mockListDocuments).toHaveBeenCalledTimes(4);
  });

  it('records an actionable error when cleanup readback does not converge', async () => {
    const newDocument = {
      name: 'stores/test/documents/new-reference-card',
      displayName: 'reference_card:revenue-canonical-definition',
      state: 'STATE_ACTIVE',
    };
    const oldDuplicate = {
      name: 'stores/test/documents/old-reference-card',
      displayName: 'reference_card:revenue-canonical-definition',
      state: 'STATE_ACTIVE',
    };
    mockUpload.mockImplementationOnce(async (params) => {
      uploadedDisplayNames.push(params.config.displayName);
      return {
        name: 'operations/upload-new-reference-card',
        response: { fileSearchStoreDocument: { name: newDocument.name } },
      };
    });
    mockListDocuments.mockResolvedValue([newDocument, oldDuplicate]);

    const result = await syncMarkdownDocumentsToFileSearch([
      {
        id: 'revenue-canonical-definition',
        displayName: 'reference_card:revenue-canonical-definition',
        markdown: '# ReferenceCard: revenue-canonical-definition',
      },
    ], 'stores/test', 'key', {
      ...syncTestOptions(),
      cleanupPollAttempts: 2,
    });

    expect(result.uploaded).toBe(1);
    expect(result.verified).toBe(1);
    expect(result.active).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('File Search cleanup did not converge');
    expect(result.errors[0]).toContain('active documents');
  });
});
