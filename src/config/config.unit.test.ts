import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema, runtimeDir } from './index.js';

describe('ConfigSchema defaults', () => {
  it('fills sensible defaults from an empty object', () => {
    const c = ConfigSchema.parse({});
    expect(c.modelId).toBe('claude-opus-4-8');
    expect(c.recoveryModelId).toBe('claude-haiku-4-5');
    expect(c.effort).toBe('high');
    expect(c.timezone).toBe('America/New_York');
    expect(c.owner).toEqual({ name: 'Devon', identities: [] });
    expect(c.allowGroups).toBe(true);
    expect(c.recentWindowSize).toBe(30);
    expect(c.memory).toEqual({ userMaxChars: 8000, sunnyMaxChars: 6000, indexMaxChars: 2000 });
    expect(c.server).toEqual({ port: 8787, webhookPath: '/webhooks/sendblue' });
  });

  it('accepts overrides and keeps the rest defaulted', () => {
    const c = ConfigSchema.parse({ effort: 'max', owner: { identities: ['+15551230000'] } });
    expect(c.effort).toBe('max');
    expect(c.owner).toEqual({ name: 'Devon', identities: ['+15551230000'] });
    expect(c.modelId).toBe('claude-opus-4-8');
  });

  it('rejects an out-of-range effort', () => {
    expect(() => ConfigSchema.parse({ effort: 'turbo' })).toThrow();
  });

  it('rejects a non-positive recent window size', () => {
    expect(() => ConfigSchema.parse({ recentWindowSize: 0 })).toThrow();
    expect(() => ConfigSchema.parse({ recentWindowSize: -5 })).toThrow();
  });
});

describe('runtimeDir', () => {
  const original = process.env.SUNNY_HOME;
  beforeEach(() => {
    delete process.env.SUNNY_HOME;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SUNNY_HOME;
    else process.env.SUNNY_HOME = original;
  });

  it('defaults to ~/.sunny', () => {
    expect(runtimeDir()).toBe(join(homedir(), '.sunny'));
  });

  it('honors the SUNNY_HOME override', () => {
    process.env.SUNNY_HOME = '/custom/sunny/home';
    expect(runtimeDir()).toBe('/custom/sunny/home');
  });
});
