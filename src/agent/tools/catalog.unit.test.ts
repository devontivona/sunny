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
        'send_message',
        'stay_silent',
        'start_job',
        'memory_write',
        'read_topic',
        'recall_history',
        'schedule_create',
        'schedule_list',
        'schedule_delete',
        'credential_manage',
        'mcp_manage',
        'bash',
        'file_read',
      ]),
    );
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('flags host/registry/scheduling tools as owner-only and the rest as broad', () => {
    const byName = new Map(toolCatalog(makeConfig()).map((e) => [e.name, e]));
    for (const n of ['bash', 'file_read', 'credential_manage', 'mcp_manage', 'schedule_create']) {
      expect(byName.get(n)?.ownerOnly, n).toBe(true);
    }
    for (const n of ['send_message', 'stay_silent', 'start_job', 'memory_write']) {
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
    // A no-arg tool (stay_silent) has no parameters.
    expect(toolCatalog(makeConfig()).find((e) => e.name === 'stay_silent')?.params).toEqual([]);
  });
});
