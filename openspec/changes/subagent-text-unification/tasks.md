## 1. Sentinels and parsing (src/agent/delivery.ts)

- [ ] 1.1 Add `NO_REPORT_SENTINEL` (`<no-report/>`) and generalize `stripNoReply` into a shared sentinel-strip helper (`stripNoReply` keeps its exact behavior; the child path uses the same mechanics with the new token — sentinel-only → nothing, content + stray sentinel → content with token stripped)
- [ ] 1.2 Add `<report>…</report>` block extraction: a pure helper that, given text, returns complete block contents + the text with those blocks removed (unterminated blocks are left as plain text, never partially delivered)
- [ ] 1.3 Unit tests: sentinel-only final, content + stray sentinel, block extraction (zero/one/many, unterminated, block spanning lines), literal-token-in-quoted-content edge cases

## 2. Child run shell (workflows/subagent.ts, workflows/runShell.ts)

- [ ] 2.1 `runShell.ts`: add the optional `reportBlocks: { send }` hook to `streamAgent` (journaled cursor over `steps[].content` text parts, sibling of the translator fold; deliver each complete block via the supplied memoized step; skipped when a steer folded this step is NOT needed here — blocks are child-authored, deliver regardless)
- [ ] 2.2 `subagent.ts`: drop the `SEND_MESSAGE_SPEC` import and the `send_message` report tool from `buildChildTools` (`none` toolset returns `{}`); wire `reportBlocks` to `deliver({kind:'parent'})`
- [ ] 2.3 `subagent.ts`: terminal report — extract final text, strip already-delivered blocks and the `<no-report/>` sentinel, deliver unconditionally when the link is still running (keep the `linkRunningStep` cancel suppression); on empty final without sentinel, fall back to raw interim narration, then the fixed empty-result notice
- [ ] 2.4 Record the child's delivery classification for telemetry using the text-mode vocabulary (`text` / `silence` / `fallback_text`)

## 3. Prompt (src/agent/prompt.ts)

- [ ] 3.1 Rewrite `buildSubagentPrompt`'s "How you report" block per design D5: final-text-is-your-report, compact-structured contract kept, `<report>` block convention ("most tasks need no progress report"), `<no-report/>` sentinel; update the module doc comment (the "job vs interactive delivery model" framing is now uniform)

## 4. Tests and evals

- [ ] 4.1 Workflow tests for the child profile: terminal final-text report delivered + attributed; sentinel-only final delivers nothing and closes the link `done`; mid-task block delivered while the run continues and not re-delivered terminally or on replay; cancel suppression still holds; empty-final fallback chain
- [ ] 4.2 Update the delegation / tool-selection eval cases that assert `send_message`-based child reporting to text assertions; run the delegation eval cell as the merge gate
- [ ] 4.3 Live smoke: `delegate_task` from the owner DM; confirm the attributed report arrives on the parent thread and `list_runs` shows closure; restart the devbox service after merge (HMR staleness)

## 5. SEND_MESSAGE_SPEC endgame (gated on the parallel conversation-cleanup branch landing)

- [ ] 5.1 Once the conversation turn's tool mode is deleted on main: remove `SEND_MESSAGE_SPEC` and `src/agent/tools/sendMessage.ts`, and prune the now-unused child-report seat of `extractSends`/`sendMessagePart` consumers (keep whatever legacy-row history rendering still needs)
