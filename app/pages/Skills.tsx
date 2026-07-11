import { apiGet } from '../api';
import type { SkillDetail, SkillsView } from '../types';
import { Markdown } from '../components/Markdown';
import { Link } from '../components/Link';
import { ErrorNote, Loading, PageTitle, Panel, useAsync } from '../components/ui';

// Skills directory (web-dashboard agent-tooling delta): every builtin, installed,
// and self-authored skill with its description, trust tier, and source — each
// openable at `skills/<name>` to view the full SKILL.md and the other files it
// ships. Observe-only: no control to run, edit, install, or delete. An authored
// skill that shadows a builtin (a fork) is annotated so stale forks stay visible.

function trustClass(trust: string): string {
  if (trust === 'builtin') return 'text-fg-dim';
  return trust === 'authored' ? 'text-success' : 'text-warning';
}

function SkillView({ name }: { name: string }) {
  const state = useAsync<SkillDetail>(
    () => apiGet<SkillDetail>(`/skills/${encodeURIComponent(name)}`),
    [name],
  );
  return (
    <div>
      <PageTitle>{name}/SKILL.md</PageTitle>
      <p className="mb-md">
        <Link to="skills">← all skills</Link>
      </p>
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <ErrorNote error={state.error} />}
      {state.status === 'ready' && (
        <>
          <div className="mb-md flex items-baseline gap-sm">
            <span className={trustClass(state.data.trust)}>[{state.data.trust}]</span>
            {state.data.source && <span className="text-fg-dim">{state.data.source}</span>}
          </div>
          <Markdown>{state.data.body || '_(empty)_'}</Markdown>
          <Panel title="SKILL DIRECTORY">
            <ul className="text-fg-muted">
              {state.data.files.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </Panel>
        </>
      )}
    </div>
  );
}

function SkillsHome() {
  const state = useAsync<SkillsView>(() => apiGet<SkillsView>('/skills'), []);
  return (
    <div>
      <PageTitle>Skills</PageTitle>
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <ErrorNote error={state.error} />}
      {state.status === 'ready' &&
        (state.data.skills.length === 0 ? (
          <p className="text-fg-dim">No skills.</p>
        ) : (
          <ul>
            {state.data.skills.map((s) => (
              <li key={s.name} className="mb-sm">
                <div className="flex items-baseline gap-sm">
                  <Link to={`skills/${encodeURIComponent(s.name)}`}>{s.name}</Link>
                  <span className={trustClass(s.trust)}>[{s.trust}]</span>
                  {s.shadowsBuiltin && <span className="text-warning">[fork of builtin]</span>}
                  {s.source && <span className="text-fg-dim">{s.source}</span>}
                </div>
                <div className="text-fg-muted">{s.description}</div>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

export function Skills({ name }: { name: string | null }) {
  return name ? <SkillView name={name} /> : <SkillsHome />;
}
