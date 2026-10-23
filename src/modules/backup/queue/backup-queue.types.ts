import {
  type BackupMode,
  type BackupTrigger,
  type SourceGroup,
} from '../types';

export interface BackupQueueJobData {
  runId: string;
  trigger: BackupTrigger;
  mode: BackupMode;
  sourceGroups?: SourceGroup[];
  databases?: string[];
}
