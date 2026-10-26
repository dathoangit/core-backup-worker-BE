import fs from 'node:fs';
import path from 'node:path';

import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { BackupConfigService } from '../backup-config.service';
import { hashFile } from '../engine/copy-writer';
import { type RunManifest } from '../types';
import { PrimaryZoneService } from '../zones/primary-zone.service';

const TZ = 'Asia/Ho_Chi_Minh';

export type BackupFileKind = 'full' | 'append' | 'cdc' | 'snapshot' | 'logical';

export interface BackupFileEntry {
  relativePath: string;
  absolutePath: string;
  runId: string;
  database: string;
  sourceGroup: string;
  kind: BackupFileKind;
  sizeBytes: number;
  rowCount: number;
  sha256: string | null;
  md5: string | null;
  modifiedAt: string;
  date: string;
}

export interface BackupFilesTreeNode {
  date: string;
  groups: Array<{
    group: string;
    databases: Array<{
      database: string;
      fileCount: number;
      totalBytes: number;
    }>;
  }>;
}

@Injectable()
export class BackupFilesService {
  private readonly logger = new Logger(BackupFilesService.name);

  private readonly checksumCache = new Map<
    string,
    { mtimeMs: number; sha256: string; md5: string }
  >();

  constructor(
    private readonly backupConfig: BackupConfigService,
    private readonly primaryZone: PrimaryZoneService,
  ) {}

  async getTree(): Promise<BackupFilesTreeNode[]> {
    const files = await this.collectAllFiles();
    const byDate = new Map<string, BackupFileEntry[]>();

    for (const file of files) {
      const list = byDate.get(file.date) ?? [];
      list.push(file);
      byDate.set(file.date, list);
    }

    return [...byDate.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, dateFiles]) => {
        const byGroup = new Map<string, BackupFileEntry[]>();

        for (const file of dateFiles) {
          const list = byGroup.get(file.sourceGroup) ?? [];
          list.push(file);
          byGroup.set(file.sourceGroup, list);
        }

        return {
          date,
          groups: [...byGroup.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([group, groupFiles]) => {
              const byDb = new Map<string, BackupFileEntry[]>();

              for (const file of groupFiles) {
                const list = byDb.get(file.database) ?? [];
                list.push(file);
                byDb.set(file.database, list);
              }

              return {
                group,
                databases: [...byDb.entries()]
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([database, dbFiles]) => ({
                    database,
                    fileCount: dbFiles.length,
                    totalBytes: dbFiles.reduce(
                      (sum, row) => sum + row.sizeBytes,
                      0,
                    ),
                  })),
              };
            }),
        };
      });
  }

  async listFiles(options: {
    date?: string;
    database?: string;
  }): Promise<BackupFileEntry[]> {
    const files = await this.collectAllFiles();

    return files.filter((file) => {
      if (options.date && file.date !== options.date) {
        return false;
      }

      if (options.database && file.database !== options.database) {
        return false;
      }

      return true;
    });
  }

  async computeChecksum(relativePath: string): Promise<{
    relativePath: string;
    sha256: string;
    md5: string;
    sizeBytes: number;
  }> {
    const absolute = await this.resolveSafePath(relativePath);
    const stat = fs.statSync(absolute);
    const cacheKey = absolute;
    const cached = this.checksumCache.get(cacheKey);

    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return {
        relativePath,
        sha256: cached.sha256,
        md5: cached.md5,
        sizeBytes: stat.size,
      };
    }

    const hashed = await hashFile(absolute);
    this.checksumCache.set(cacheKey, {
      mtimeMs: stat.mtimeMs,
      sha256: hashed.sha256,
      md5: hashed.md5,
    });

    return {
      relativePath,
      sha256: hashed.sha256,
      md5: hashed.md5,
      sizeBytes: hashed.bytes,
    };
  }

  private async collectAllFiles(): Promise<BackupFileEntry[]> {
    const settings = await this.backupConfig.getSettings();
    const volumeRoots = [
      settings.backupDir,
      settings.volumeDirs.HIS,
      settings.volumeDirs.EMR,
      settings.volumeDirs.LIS,
    ];
    const runIds = await this.primaryZone.listRunIds();
    const files: BackupFileEntry[] = [];

    for (const runId of runIds) {
      const manifest = (await this.primaryZone.readManifest(
        runId,
      )) as RunManifest | null;

      if (!manifest) {
        continue;
      }

      const date = this.toDateKey(manifest.startedAt);

      for (const db of manifest.databases ?? []) {
        for (const chunk of db.chunks ?? []) {
          const absolutePath = chunk.file;

          if (!absolutePath || !fs.existsSync(absolutePath)) {
            continue;
          }

          let sizeBytes = chunk.bytes;
          let modifiedAt = manifest.startedAt;

          try {
            const stat = fs.statSync(absolutePath);
            sizeBytes = stat.size;
            modifiedAt = stat.mtime.toISOString();
          } catch {
            // keep chunk metadata
          }

          files.push({
            relativePath: this.toRelativePath(absolutePath, volumeRoots),
            absolutePath,
            runId,
            database: db.database,
            sourceGroup: db.group,
            kind: this.kindFromPath(absolutePath),
            sizeBytes,
            rowCount: Math.max(chunk.rowCount, 0),
            sha256: chunk.sha256 ?? null,
            md5: chunk.md5 ?? null,
            modifiedAt,
            date,
          });
        }
      }
    }

    return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  private async resolveSafePath(relativePath: string): Promise<string> {
    if (
      !relativePath ||
      relativePath.includes('\0') ||
      path.isAbsolute(relativePath) ||
      relativePath.split(/[/\\]/).includes('..')
    ) {
      throw new BadRequestException('Invalid relativePath');
    }

    const settings = await this.backupConfig.getSettings();
    const roots = [
      path.resolve(settings.backupDir),
      path.resolve(settings.volumeDirs.HIS),
      path.resolve(settings.volumeDirs.EMR),
      path.resolve(settings.volumeDirs.LIS),
    ];

    for (const root of roots) {
      const candidate = path.resolve(root, relativePath);

      if (!candidate.startsWith(`${root}${path.sep}`) && candidate !== root) {
        continue;
      }

      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
        continue;
      }

      const real = fs.realpathSync(candidate);
      const realRoot = fs.realpathSync(root);

      if (!real.startsWith(`${realRoot}${path.sep}`) && real !== realRoot) {
        continue;
      }

      return real;
    }

    throw new BadRequestException('File not found inside backup volumes');
  }

  private toRelativePath(absolutePath: string, roots: string[]): string {
    const resolved = path.resolve(absolutePath);

    for (const root of roots) {
      const resolvedRoot = path.resolve(root);

      if (resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
        return path.relative(resolvedRoot, resolved).split(path.sep).join('/');
      }
    }

    return path.basename(resolved);
  }

  private kindFromPath(filePath: string): BackupFileKind {
    const normalized = filePath.replaceAll('\\', '/');

    if (normalized.includes('/snapshots/')) {
      return 'snapshot';
    }

    if (normalized.includes('/logical/')) {
      return 'logical';
    }

    if (normalized.includes('/append/')) {
      return 'append';
    }

    if (normalized.includes('/cdc/')) {
      return 'cdc';
    }

    return 'full';
  }

  private toDateKey(iso: string): string {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(iso));
    } catch {
      this.logger.warn(`Invalid startedAt for date key: ${iso}`);

      return 'unknown';
    }
  }
}
