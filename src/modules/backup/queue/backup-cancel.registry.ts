import { Injectable, Logger } from '@nestjs/common';

export type BackupQueryKiller = () => Promise<void> | void;

/**
 * In-process cancel flags + registered native query killers for active runs.
 */
@Injectable()
export class BackupCancelRegistry {
  private readonly logger = new Logger(BackupCancelRegistry.name);

  private readonly controllers = new Map<string, AbortController>();

  private readonly killers = new Map<string, Set<BackupQueryKiller>>();

  begin(runId: string): AbortSignal {
    this.clear(runId);
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    this.killers.set(runId, new Set());

    return controller.signal;
  }

  registerKiller(runId: string, killer: BackupQueryKiller): () => void {
    let set = this.killers.get(runId);

    if (!set) {
      set = new Set();
      this.killers.set(runId, set);
    }

    set.add(killer);

    return () => {
      set.delete(killer);
    };
  }

  async requestCancel(runId: string): Promise<boolean> {
    const controller = this.controllers.get(runId);

    if (controller && !controller.signal.aborted) {
      controller.abort();
    }

    const set = this.killers.get(runId);

    if (set && set.size > 0) {
      await Promise.all(
        [...set].map(async (killer) => {
          try {
            await killer();
          } catch (error) {
            this.logger.warn(
              `Killer for run ${runId} failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }),
      );
    }

    return Boolean(controller) || Boolean(set && set.size > 0);
  }

  isCancelRequested(runId: string): boolean {
    return this.controllers.get(runId)?.signal.aborted ?? false;
  }

  clear(runId: string): void {
    this.controllers.delete(runId);
    this.killers.delete(runId);
  }
}
