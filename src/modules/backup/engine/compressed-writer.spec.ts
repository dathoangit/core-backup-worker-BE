import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import {
  compressedCsvExt,
  setDefaultCompressionSettings,
  writeStreamToCompressedFile,
} from './compressed-writer';

describe('compressed-writer', () => {
  const dir = path.join(tmpdir(), `backup-zstd-${process.pid}`);

  beforeAll(() => {
    mkdirSync(dir, { recursive: true });
    setDefaultCompressionSettings({
      codec: 'zstd',
      level: 1,
      threads: 1,
      verify: true,
    });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exposes .csv.zst extension for zstd codec', () => {
    expect(compressedCsvExt('zstd')).toBe('.csv.zst');
    expect(compressedCsvExt('gzip')).toBe('.csv.gz');
  });

  it('writes a valid zstd file with atomic rename', async () => {
    const out = path.join(dir, `sample${compressedCsvExt()}`);
    const source = Readable.from([
      Buffer.from('a,b\n1,2\n'),
      Buffer.from('3,4\n'),
    ]);
    const result = await writeStreamToCompressedFile(source, out, {
      codec: 'zstd',
      level: 1,
      threads: 1,
      verify: true,
    });

    expect(existsSync(out)).toBe(true);
    expect(existsSync(`${out}.partial`)).toBe(false);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.sha256).toMatch(/^[\da-f]{64}$/);
  });

  it('does not leave a final file when upstream fails before finish', async () => {
    const out = path.join(dir, `fail${compressedCsvExt()}`);
    const source = new Readable({
      read() {
        this.destroy(new Error('boom'));
      },
    });

    await expect(
      writeStreamToCompressedFile(source, out, {
        codec: 'zstd',
        level: 1,
        threads: 1,
        verify: false,
      }),
    ).rejects.toThrow();

    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.partial`)).toBe(false);
  });

  it('supports gzip fallback', async () => {
    const out = path.join(dir, 'sample.csv.gz');
    const source = Readable.from([Buffer.from('hello gzip\n')]);
    const result = await writeStreamToCompressedFile(source, out, {
      codec: 'gzip',
      level: 6,
      verify: false,
    });

    expect(existsSync(out)).toBe(true);
    expect(result.sha256).toMatch(/^[\da-f]{64}$/);
    // gzip magic
    const head = readFileSync(out).subarray(0, 2);
    expect(head[0]).toBe(31);
    expect(head[1]).toBe(139);
  });

  it('removes .partial when aborted', async () => {
    const out = path.join(dir, `abort${compressedCsvExt()}`);
    const controller = new AbortController();
    const source = new Readable({
      read() {
        this.push(Buffer.alloc(64 * 1024, 1));
      },
    });

    const pending = writeStreamToCompressedFile(source, out, {
      codec: 'zstd',
      level: 1,
      threads: 1,
      verify: false,
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).rejects.toThrow();
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.partial`)).toBe(false);
  });
});
