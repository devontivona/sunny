import { describe, expect, it } from 'vitest';
import { createStaySilentTool, type SilenceFlag } from './staySilent.js';

describe('createStaySilentTool', () => {
  it('sets the silence flag when executed', async () => {
    const flag: SilenceFlag = { silent: false };
    const tool = createStaySilentTool(flag);
    const result = await tool.execute!({}, { toolCallId: 't1', messages: [], context: {} });
    expect(flag.silent).toBe(true);
    expect(result).toMatch(/silent/i);
  });

  it('starts from an unset flag', () => {
    const flag: SilenceFlag = { silent: false };
    createStaySilentTool(flag);
    expect(flag.silent).toBe(false); // not set until executed
  });
});
