export const ARCHIVE_TARGET = Symbol('ARCHIVE_TARGET');

export interface ArchiveResult {
  status: 'published' | 'not-configured' | 'skipped' | 'error';
  message?: string;
}

export interface ArchiveTarget {
  readonly name: string;
  isConfigured(): boolean;
  publishRun(runId: string, runDir: string): Promise<ArchiveResult>;
}
