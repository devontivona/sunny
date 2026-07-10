import { describe, expect, it } from 'vitest';
import { makeConfig } from '../../../tests/factories.js';
import { toolCatalog } from './catalog.js';

describe('toolCatalog', () => {
  it('lists every registered tool the loop assembles, name-sorted', () => {
    const entries = toolCatalog(makeConfig());
    const names = entries.map((e) => e.name);
    // Exact set the turn loop registers (broad + owner-DM-only). A tool added to a
    // factory should appear here automatically — update this assertion when it does.
    expect(new Set(names)).toEqual(
      new Set([
        'send_image',
        'wait',
        'memory_write',
        'read_topic',
        'recall_history',
        'recall_expand',
        'delegate_task',
        'message',
        'schedule_create',
        'list_runs',
        'cancel_run',
        'credential_manage',
        'mcp_manage',
        'bash',
        'file_read',
        'file_write',
        'file_edit',
      ]),
    );
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('flags host/registry/scheduling tools as owner-only and the rest as broad', () => {
    const byName = new Map(toolCatalog(makeConfig()).map((e) => [e.name, e]));
    for (const n of [
      'bash',
      'file_read',
      'file_write',
      'file_edit',
      'credential_manage',
      'mcp_manage',
      'schedule_create',
      'delegate_task',
      'message',
    ]) {
      expect(byName.get(n)?.ownerOnly, n).toBe(true);
    }
    for (const n of ['send_image', 'memory_write']) {
      expect(byName.get(n)?.ownerOnly, n).toBe(false);
    }
  });

  it('distills a one-line purpose from each description (capped, single sentence)', () => {
    for (const e of toolCatalog(makeConfig())) {
      expect(e.purpose.length).toBeGreaterThan(0);
      expect(e.purpose.length).toBeLessThanOrEqual(160);
      expect(e.purpose).not.toContain('\n');
    }
    // The bash purpose is the first sentence of its (multi-sentence) description.
    expect(toolCatalog(makeConfig()).find((e) => e.name === 'bash')?.purpose).toBe(
      'Run a shell command on the host (bash -c) and return its stdout, stderr, and exit code.',
    );
  });

  it('derives input parameters from each tool schema (name/type/required/desc)', () => {
    const bash = toolCatalog(makeConfig()).find((e) => e.name === 'bash')!;
    const command = bash.params.find((p) => p.name === 'command');
    expect(command).toEqual({
      name: 'command',
      type: 'string',
      required: true,
      description: 'The shell command to run.',
    });
    // Optional params are flagged not-required (e.g. bash `cwd`).
    expect(bash.params.find((p) => p.name === 'cwd')?.required).toBe(false);
    // send_image: pathOrUrl required, caption optional.
    const sendImage = toolCatalog(makeConfig()).find((e) => e.name === 'send_image')!;
    expect(sendImage.params.find((x) => x.name === 'pathOrUrl')?.required).toBe(true);
    expect(sendImage.params.find((x) => x.name === 'caption')?.required).toBe(false);
  });
});
