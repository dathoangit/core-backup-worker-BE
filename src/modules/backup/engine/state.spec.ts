import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { acquireLock } from './lock';
import {
  beginOrResumePending,
  commitWatermark,
  defaultState,
  loadState,
  markChunkComplete,
  saveState,
} from './state';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'his-backup-'));
  tempDirs.push(dir);

  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('lock', () => {
  it('allows only one live holder', () => {
    const dir = makeTempDir();
    const first = acquireLock(dir);
    expect(first).toBeTruthy();
    const second = acquireLock(dir);
    expect(second).toBeNull();
    first!.release();
    const third = acquireLock(dir);
    expect(third).toBeTruthy();
    third!.release();
  });

  it('replaces a stale lock from a dead pid', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'backup.lock'), '999999999\n', 'utf8');
    const lock = acquireLock(dir);
    expect(lock).toBeTruthy();
    lock!.release();
  });
});

describe('checkpoint commit', () => {
  it('does not advance watermark until commitWatermark', () => {
    const dir = makeTempDir();
    let state = defaultState('adempiere');
    saveState(dir, 'produce', state);

    const pending = beginOrResumePending(state, '100', 'run-1');
    state = { ...state, pending };
    saveState(dir, 'produce', state);

    const loaded = loadState(dir, 'produce', 'adempiere');
    expect(loaded.watermark).toBeNull();
    expect(loaded.pending?.captured).toBe('100');

    const withChunk = markChunkComplete(loaded.pending!, 'chunk-a');
    saveState(dir, 'produce', { ...loaded, pending: withChunk });

    const mid = loadState(dir, 'produce', 'adempiere');
    expect(mid.watermark).toBeNull();
    expect(mid.pending?.completedChunkKeys).toEqual(['chunk-a']);

    const committed = commitWatermark(mid, mid.pending!.captured);
    saveState(dir, 'produce', committed);

    const done = loadState(dir, 'produce', 'adempiere');
    expect(done.watermark).toBe('100');
    expect(done.pending).toBeNull();
    expect(done.initialFullDone).toBe(true);
  });

  it('resumes the unfinished capture window instead of jumping ahead', () => {
    const state = {
      ...defaultState('adempiere'),
      pending: {
        captured: '100',
        runId: 'run-1',
        completedChunkKeys: ['chunk-a'],
      },
    };

    const pending = beginOrResumePending(state, '200', 'run-2');
    expect(pending.captured).toBe('100');
    expect(pending.runId).toBe('run-1');
    expect(pending.completedChunkKeys).toEqual(['chunk-a']);
  });
});
