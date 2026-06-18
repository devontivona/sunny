import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '../api';
import type { AuthState } from '../types';
import { Takeover } from './ui';
import { LinkButton } from './Link';

// iMessage-approval pairing UI (D-WD4). An unrecognized device creates a pending
// access request (which makes Sunny DM the owner an approval link), then shows a
// "waiting for approval" state that polls until the owner taps the link and the
// server issues a session cookie. Default-deny: nothing private renders here.

type Phase =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'waiting'; requestId: string; deviceHint: string }
  | { kind: 'denied' }
  | { kind: 'error'; message: string };

export function AuthGate({
  initial,
  onAuthenticated,
}: {
  initial: AuthState;
  onAuthenticated: () => void;
}) {
  const [phase, setPhase] = useState<Phase>(
    initial.state === 'pending'
      ? { kind: 'waiting', requestId: initial.requestId, deviceHint: initial.deviceHint }
      : { kind: 'idle' },
  );
  const polling = useRef(false);

  const requestAccess = useCallback(async () => {
    setPhase({ kind: 'requesting' });
    try {
      const res = await apiPost<{ requestId: string; deviceHint: string }>('/auth/request');
      setPhase({ kind: 'waiting', requestId: res.requestId, deviceHint: res.deviceHint });
    } catch (e) {
      setPhase({ kind: 'error', message: (e as Error).message });
    }
  }, []);

  // Poll for approval while waiting.
  useEffect(() => {
    if (phase.kind !== 'waiting' || polling.current) return;
    polling.current = true;
    const timer = setInterval(async () => {
      try {
        const s = await apiGet<AuthState>('/auth/status');
        if (s.state === 'authenticated' || s.state === 'open') {
          clearInterval(timer);
          onAuthenticated();
        } else if (s.state === 'anonymous') {
          clearInterval(timer);
          setPhase({ kind: 'denied' });
        }
      } catch {
        /* transient; keep polling */
      }
    }, 3000);
    return () => {
      clearInterval(timer);
      polling.current = false;
    };
  }, [phase, onAuthenticated]);

  return (
    <Takeover>
      <div className="w-full max-w-[480px]">
        <div className="mb-sm font-bold tracking-[0.2em] text-fg">サニー</div>

        {(phase.kind === 'idle' || phase.kind === 'requesting') && (
          <>
            <p className="mb-md text-fg-muted">
              This device isn't recognized. Request access and Sunny will message the owner an
              approval link.
            </p>
            <LinkButton bracketed disabled={phase.kind === 'requesting'} onClick={requestAccess}>
              {phase.kind === 'requesting' ? 'requesting…' : 'request access'}
            </LinkButton>
          </>
        )}

        {phase.kind === 'waiting' && (
          <>
            <p className="mb-sm text-fg">Waiting for owner approval…</p>
            <p className="mb-md text-fg-dim">
              An approval prompt was sent to the owner. Approve it from your iMessage to continue.
            </p>
            <dl className="grid grid-cols-[5rem_1fr] text-fg-muted">
              <dt className="text-fg-dim">request</dt>
              <dd>{phase.requestId.slice(0, 8)}…</dd>
              <dt className="text-fg-dim">device</dt>
              <dd>{phase.deviceHint}</dd>
            </dl>
            <div className="mt-md flex items-center gap-sm text-fg-dim">
              <span className="inline-block size-[8px] animate-pulse rounded-full bg-warning" />
              polling for approval…
            </div>
          </>
        )}

        {phase.kind === 'denied' && (
          <>
            <p className="mb-md text-error">Access was not granted (denied or timed out).</p>
            <LinkButton bracketed onClick={requestAccess}>
              request again
            </LinkButton>
          </>
        )}

        {phase.kind === 'error' && <p className="text-error">error: {phase.message}</p>}
      </div>
    </Takeover>
  );
}
