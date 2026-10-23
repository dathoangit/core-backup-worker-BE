import { type BackupProgressPublisher } from './backup-progress.publisher';
import { type BackupProgressSink } from './backup-progress.types';

export interface BackupRunProgressContext {
  progress: BackupProgressPublisher;
  runId: string;
}

export function progressSink(
  ctx: BackupRunProgressContext | undefined,
): BackupProgressSink | undefined {
  if (!ctx) {
    return undefined;
  }

  return ctx.progress.sinkFor(ctx.runId);
}
