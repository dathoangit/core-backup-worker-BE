export class BackupCancelledError extends Error {
  constructor(runId: string) {
    super(`Backup run ${runId} was cancelled`);
    this.name = 'BackupCancelledError';
  }
}
