import { describe, expect, it } from 'vitest';
import { finalizeSpeech, laneSentinel, voiceBlock } from './voice.js';

describe('voice layer (unified-voice-layer D-VL3/4)', () => {
  it('lane sentinels: speaker = <no-reply/>, reporter = <no-report/>', () => {
    expect(laneSentinel('speaker')).toBe('<no-reply/>');
    expect(laneSentinel('reporter')).toBe('<no-report/>');
  });

  it('speaker block keeps the PR #30 ack framing verbatim (held silence 5/6 — never reword)', () => {
    const block = voiceBlock({ lane: 'speaker', subject: 'Devon' }).join('\n');
    expect(block).toContain(
      `- Silence is valid: when Devon's message just closes the loop — a 👍 or reaction, "ok",`,
    );
    expect(block).toContain('with exactly <no-reply/> and nothing else');
    expect(block).toContain(`Don't acknowledge`);
  });

  it('speaker block carries the worker-report addressing rule (the pathology-2 fix)', () => {
    const block = voiceBlock({ lane: 'speaker', subject: 'Devon' }).join('\n');
    expect(block).toContain('"<name> (subagent):" or "<name> (scheduled):"');
    expect(block).toContain('Your reply still goes to Devon, never to a');
    expect(block).toContain('use the message tool with its id');
  });

  it('reporter block states the report contract for its named recipient', () => {
    const block = voiceBlock({ lane: 'reporter', recipient: 'your orchestrator' }).join('\n');
    expect(block).toContain('Your FINAL text is your report');
    expect(block).toContain('your orchestrator when you finish');
    expect(block).toContain('make your reply exactly <no-report/>');
    // Reporters hand media paths to the mediating turn (D-VL9) — they never send.
    expect(block).toContain('put their paths in the report');
  });

  it('neither lane block contains example messages, only rules (prompt-examples-become-output)', () => {
    for (const spec of [
      { lane: 'speaker' as const, subject: 'Devon' },
      { lane: 'reporter' as const, recipient: 'your orchestrator' },
    ]) {
      const block = voiceBlock(spec).join('\n');
      expect(block).not.toMatch(/e\.g\. "(?:Morning|Hey|Hi|Done)/);
    }
  });

  it('finalizeSpeech (speaker): sentinel presence silences; no block extraction', () => {
    expect(finalizeSpeech('here is your answer', 'speaker')).toEqual({
      reports: [],
      final: 'here is your answer',
      sentinel: false,
    });
    expect(finalizeSpeech('notes about nothing\n\n<no-reply/>', 'speaker')).toEqual({
      reports: [],
      final: '',
      sentinel: true,
    });
    // A speaker's text has no report-block convention: blocks pass through untouched.
    const withBlock = finalizeSpeech('<report>not a block here</report> hi', 'speaker');
    expect(withBlock.final).toContain('<report>');
    expect(withBlock.reports).toEqual([]);
  });

  it('finalizeSpeech (reporter): extracts blocks, parses <no-report/>, presence = silence', () => {
    const s = finalizeSpeech('<report>found the blocker</report>\nAll done: 3 items.', 'reporter');
    expect(s).toEqual({ reports: ['found the blocker'], final: 'All done: 3 items.', sentinel: false });
    expect(finalizeSpeech('nothing worth relaying\n<no-report/>', 'reporter')).toEqual({
      reports: [],
      final: '',
      sentinel: true,
    });
  });

  it('cross-lane tokens do not trigger each other', () => {
    // A reporter mentioning <no-reply/> (e.g. quoting the conversation contract) stays deliverable.
    expect(finalizeSpeech('the turn replied <no-reply/> as designed', 'reporter').sentinel).toBe(false);
    expect(finalizeSpeech('the child returned <no-report/>', 'speaker').sentinel).toBe(false);
  });
});
