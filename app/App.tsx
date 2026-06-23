import { useCallback, useEffect, useState } from 'react';
import { apiGet } from './api';
import type { AuthState } from './types';
import { useRoute } from './router';
import { Layout } from './components/Layout';
import { AuthGate } from './components/AuthGate';
import { Loading, Takeover } from './components/ui';
import { Home } from './pages/Home';
import { CoreDoc } from './pages/CoreDoc';
import { Memory } from './pages/Memory';
import { Tools } from './pages/Tools';
import { Credentials } from './pages/Credentials';
import { Skills } from './pages/Skills';
import { Conversation } from './pages/Conversation';
import { Schedules } from './pages/Schedules';
import { Activity, Health } from './pages/Activity';

type Auth = { status: 'loading' } | { status: 'resolved'; state: AuthState };

function RouteView() {
  const route = useRoute();
  const [head, second] = route.segments;
  switch (head) {
    case undefined:
      return <Home />;
    case 'sunny':
      return <CoreDoc which="sunny" />;
    case 'user':
      return <CoreDoc which="user" />;
    case 'memory':
      return <Memory topic={second ?? null} />;
    case 'tools':
      return <Tools />;
    case 'credentials':
      return <Credentials />;
    case 'skills':
      return <Skills name={second ? decodeURIComponent(second) : null} />;
    case 'conversation':
      return <Conversation threadId={second ? decodeURIComponent(second) : null} />;
    case 'schedules':
      return <Schedules />;
    case 'activity':
      return <Activity />;
    case 'health':
      return <Health />;
    default:
      return <Home />;
  }
}

export function App() {
  const [auth, setAuth] = useState<Auth>({ status: 'loading' });

  const refresh = useCallback(async () => {
    try {
      const state = await apiGet<AuthState>('/auth/status');
      setAuth({ status: 'resolved', state });
    } catch {
      setAuth({ status: 'resolved', state: { state: 'anonymous' } });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onUnauthorized = () => setAuth({ status: 'resolved', state: { state: 'anonymous' } });
    window.addEventListener('dashboard:unauthorized', onUnauthorized);
    return () => window.removeEventListener('dashboard:unauthorized', onUnauthorized);
  }, [refresh]);

  if (auth.status === 'loading') {
    return (
      <Takeover>
        <Loading label="サニー · loading…" />
      </Takeover>
    );
  }

  if (auth.state.state === 'unconfigured') {
    return (
      <Takeover>
        <div className="w-full max-w-[480px]">
          <div className="mb-sm font-bold tracking-[0.2em] text-fg">サニー</div>
          <p className="text-fg-muted">
            The dashboard isn't configured. Set{' '}
            <code className="bg-surface-elevated px-xs text-primary">DASHBOARD_SESSION_SECRET</code>{' '}
            to enable iMessage-approval access (or{' '}
            <code className="bg-surface-elevated px-xs text-primary">DASHBOARD_DEV_OPEN=1</code> for
            local development).
          </p>
        </div>
      </Takeover>
    );
  }

  const authed = auth.state.state === 'authenticated' || auth.state.state === 'open';
  if (!authed) {
    return <AuthGate initial={auth.state} onAuthenticated={() => void refresh()} />;
  }

  return (
    <Layout>
      <RouteView />
    </Layout>
  );
}
