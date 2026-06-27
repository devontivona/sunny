import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import { calledStaySilent } from './delivery.js';
import { makeAssistantTurnPayload } from '../../tests/factories.js';

describe('calledStaySilent', () => {
  it('detects a stay_silent tool call in the assembled parts', () => {
    const parts = [{ type: 'tool-stay_silent', toolCallId: 'x', state: 'output-available' }];
    expect(calledStaySilent(parts as UIMessage['parts'])).toBe(true);
  });

  it('is false for a normal send turn', () => {
    expect(calledStaySilent(makeAssistantTurnPayload({ sends: ['hi'] }).parts)).toBe(false);
  });
});
