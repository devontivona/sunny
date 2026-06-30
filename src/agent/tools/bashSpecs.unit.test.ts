import { describe, expect, it } from 'vitest';
import { asSchema } from '@ai-sdk/provider-utils';
import { BASH_TOOL_SPECS } from './bashSpecs.js';

/**
 * Regression for the AI SDK v6→v7 credential-injection break: the v7 zod→JSON-Schema converter
 * renders `z.record(string, string)` as `additionalProperties: false`, which made Anthropic reject
 * every bash `credentials` map ("data/credentials must NOT have additional properties"). The bash
 * spec now hand-authors its provider JSON Schema; these tests pin that it stays correct.
 */
describe('bash tool credentials schema (vault injection regression)', () => {
  const schema = asSchema(BASH_TOOL_SPECS.bash.inputSchema);

  it('exposes credentials as an arbitrary string→string map, NOT additionalProperties:false', () => {
    const creds = (schema.jsonSchema as any).properties.credentials;
    expect(creds.type).toBe('object');
    expect(creds.additionalProperties).toEqual({ type: 'string' });
  });

  it('accepts a bash call carrying a credentials map', async () => {
    const r = await schema.validate!({
      command: 'nanobanana.py ...',
      credentials: { GEMINI_API_KEY: 'gemini-api-key' },
    });
    expect(r.success).toBe(true);
  });

  it('still rejects a malformed call (missing command)', async () => {
    const r = await schema.validate!({ credentials: { X: 'y' } });
    expect(r.success).toBe(false);
  });
});
