import { afterEach, describe, expect, it } from 'vitest';
import { setTestModelResponses, testModelResponses, TEST_TURN_MODEL_KEY } from './turnModel.js';
import type { MockResponseDescriptor } from './mockModel.js';

const reply = (text: string): MockResponseDescriptor[] => [
  { type: 'tool-call', toolName: 'send_message', input: JSON.stringify({ text }) },
];

describe('turnModel test seam (per-thread, one-shot)', () => {
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[TEST_TURN_MODEL_KEY];
  });

  it('returns a thread’s scripted responses and PERSISTS them across turns', () => {
    setTestModelResponses('loopback:test:devon', reply('pong'));
    // persists (not one-shot) → every turn on the thread is driven until cleared, so a
    // backlog/drain/retry turn can't leave the intended turn unmocked
    expect(testModelResponses('loopback:test:devon')).toEqual(reply('pong'));
    expect(testModelResponses('loopback:test:devon')).toEqual(reply('pong'));
  });

  it('isolates by thread — a mock never leaks onto another thread’s turn', () => {
    setTestModelResponses('loopback:test:devon', reply('a'));
    expect(testModelResponses('sendblue:owner:contact')).toBeUndefined(); // real model
    expect(testModelResponses('loopback:test:devon')).toEqual(reply('a')); // still there for its own turn
  });

  it('clears a thread when given no responses (reverts to the real model)', () => {
    setTestModelResponses('t1', reply('x'));
    setTestModelResponses('t1', undefined);
    expect(testModelResponses('t1')).toBeUndefined();
  });

  it('falls back to a legacy global array (the @workflow/vitest harness path)', () => {
    (globalThis as Record<symbol, unknown>)[TEST_TURN_MODEL_KEY] = reply('legacy');
    expect(testModelResponses('any-thread')).toEqual(reply('legacy'));
  });

  it('is undefined in production (nothing set)', () => {
    expect(testModelResponses('loopback:test:devon')).toBeUndefined();
  });
});
