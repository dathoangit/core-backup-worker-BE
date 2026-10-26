import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

export type CompressionCodec = 'zstd' | 'gzip';

export interface CompressionSettings {
  codec: CompressionCodec;
  level: number;
  threads: number;
  verify: boolean;
}

const DEFAULT_SETTINGS: CompressionSettings = {
  codec: 'zstd',
  level: 3,
  threads: 4,
  verify: true,
};

let defaultSettings: CompressionSettings = { ...DEFAULT_SETTINGS };

const activeChildren = new Set<ChildProcess>();
const activePartialFiles = new Set<string>();

export function setDefaultCompressionSettings(
  settings: Partial<CompressionSettings>,
): void {
  defaultSettings = {
    ...defaultSettings,
    ...settings,
  };
}

export function getDefaultCompressionSettings(): CompressionSettings {
  return { ...defaultSettings };
}

export function compressedCsvExt(
  codec: CompressionCodec = defaultSettings.codec,
): string {
  return codec === 'gzip' ? '.csv.gz' : '.csv.zst';
}

export function compressedSqlExt(
  codec: CompressionCodec = defaultSettings.codec,
): string {
  return codec === 'gzip' ? '.sql.gz' : '.sql.zst';
}

export function isCompressedCsvName(name: string): boolean {
  return name.endsWith('.csv.zst') || name.endsWith('.csv.gz');
}

export function compressedCsvSuffixPattern(): RegExp {
  return /\.csv\.(zst|gz)$/;
}

/** Kill in-flight zstd/pg children and remove .partial files (SIGTERM/shutdown). */
export function killActiveCompressionChildren(): void {
  for (const proc of activeChildren) {
    if (proc.exitCode === null && !proc.killed) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
  }

  for (const partial of activePartialFiles) {
    try {
      fs.unlinkSync(partial);
    } catch {
      // ignore
    }
  }

  activePartialFiles.clear();
}

function minimalEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH:
      process.env.PATH ||
      '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: process.env.HOME || '/tmp',
    LANG: process.env.LANG || 'C.UTF-8',
    ...extra,
  };
}

export function spawnIsolated(
  command: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): ChildProcess {
  const proc = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    env: minimalEnv(extraEnv),
  });

  activeChildren.add(proc);
  proc.once('close', () => {
    activeChildren.delete(proc);
  });

  return proc;
}

export function waitForProcess(
  proc: ChildProcess,
  name: string,
  allowedExitCodes: number[] = [0],
): Promise<void> {
  const maxStderrBytes = 16 * 1024;

  return new Promise((resolve, reject) => {
    let stderrText = '';

    proc.stderr?.on('data', (chunk: Buffer | string) => {
      stderrText += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

      if (stderrText.length > maxStderrBytes) {
        stderrText = stderrText.slice(-maxStderrBytes);
      }
    });

    proc.once('error', (err) => {
      reject(new Error(`Cannot start process [${name}]: ${err.message}`));
    });

    proc.once('close', (code, signal) => {
      const trimmed = stderrText.trim();

      if (code !== null && allowedExitCodes.includes(code)) {
        resolve();

        return;
      }

      reject(
        new Error(
          `Process [${name}] failed (exit code: ${code}, signal: ${signal}). ${trimmed}`,
        ),
      );
    });
  });
}

async function verifyZstdArchive(filePath: string): Promise<void> {
  const verifyProc = spawnIsolated('zstd', ['-t', '-q', filePath]);
  await waitForProcess(verifyProc, 'zstd-verify', [0]);
}

export interface WriteCompressedOptions {
  codec?: CompressionCodec;
  level?: number;
  threads?: number;
  verify?: boolean;
  signal?: AbortSignal;
  onBytes?: (delta: number) => void;
}

/**
 * Compress a readable stream to outputPath via zstd (or gzip fallback).
 * Writes to .partial, fsyncs, optionally runs zstd -t, then atomic rename.
 */
export async function writeStreamToCompressedFile(
  source: Readable,
  outputPath: string,
  options?: WriteCompressedOptions,
): Promise<{ bytes: number; sha256: string; md5: string }> {
  const codec = options?.codec ?? defaultSettings.codec;
  const level =
    options?.level ?? (codec === 'gzip' ? 6 : defaultSettings.level);
  const threads = options?.threads ?? defaultSettings.threads;
  const verify = options?.verify ?? defaultSettings.verify;
  const signal = options?.signal;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const tmpPath = `${outputPath}.partial`;

  if (fs.existsSync(tmpPath)) {
    fs.unlinkSync(tmpPath);
  }

  if (signal?.aborted) {
    throw new Error('Compression aborted before start');
  }

  activePartialFiles.add(tmpPath);

  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  const hasher = new Transform({
    transform(chunk, _encoding, callback) {
      sha256.update(chunk);
      md5.update(chunk);
      const size = Buffer.isBuffer(chunk)
        ? chunk.byteLength
        : Buffer.byteLength(chunk as string);

      if (size > 0) {
        options?.onBytes?.(size);
      }

      callback(null, chunk);
    },
  });

  let zstdProc: ChildProcess | null = null;

  const abortHandler = (): void => {
    try {
      source.destroy();
    } catch {
      // ignore
    }

    if (zstdProc && zstdProc.exitCode === null && !zstdProc.killed) {
      try {
        zstdProc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
  };

  signal?.addEventListener('abort', abortHandler, { once: true });

  try {
    const writeStream = fs.createWriteStream(tmpPath, { mode: 0o600 });

    if (codec === 'gzip') {
      const gzip = createGzip({ level });
      await pipeline(source, gzip, hasher, writeStream);
    } else {
      zstdProc = spawnIsolated('nice', [
        '-n',
        '19',
        'zstd',
        `-${level}`,
        `-T${threads}`,
        '--check',
        '-q',
      ]);

      await Promise.all([
        pipeline(source, zstdProc.stdin!),
        pipeline(zstdProc.stdout!, hasher, writeStream),
        waitForProcess(zstdProc, 'zstd', [0]),
      ]);
    }

    const synced = await fsp.open(tmpPath, 'r+');

    try {
      await synced.sync();
    } finally {
      await synced.close();
    }

    if (codec === 'zstd' && verify) {
      await verifyZstdArchive(tmpPath);
    }

    await fsp.rename(tmpPath, outputPath);
    activePartialFiles.delete(tmpPath);

    const bytes = fs.statSync(outputPath).size;

    return {
      bytes,
      sha256: sha256.digest('hex'),
      md5: md5.digest('hex'),
    };
  } catch (error) {
    if (zstdProc && zstdProc.exitCode === null && !zstdProc.killed) {
      try {
        zstdProc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }

    await fsp.unlink(tmpPath).catch(() => null);
    activePartialFiles.delete(tmpPath);

    if (signal?.aborted) {
      throw new Error('Compression aborted');
    }

    throw error;
  } finally {
    signal?.removeEventListener('abort', abortHandler);
  }
}
