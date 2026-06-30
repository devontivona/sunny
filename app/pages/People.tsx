import { apiGet } from '../api';
import type { PeopleView, PersonDetail, PersonSummary } from '../types';
import { Markdown } from '../components/Markdown';
import { Link } from '../components/Link';
import { ErrorNote, Loading, PageTitle, useAsync } from '../components/ui';

// People directory (multiplayer-family): the trust roster — the owner plus each
// configured family member — and their profile docs (owner → USER.md, family →
// people/<id>.md). Observe-only: shows who Sunny trusts and what it knows about them.

function roleClass(role: string | null): string {
  return role === 'owner' ? 'text-primary' : 'text-secondary';
}

function roleTag(role: string | null) {
  return <span className={roleClass(role)}>[{role ?? 'unknown'}]</span>;
}

function PersonView({ id }: { id: string }) {
  const state = useAsync<PersonDetail>(
    () => apiGet<PersonDetail>(`/people/${encodeURIComponent(id)}`),
    [id],
  );
  return (
    <div>
      <PageTitle>{id === 'owner' ? 'USER.md' : `people/${id}.md`}</PageTitle>
      <p className="mb-md">
        <Link to="people">← all people</Link>
      </p>
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <ErrorNote error={state.error} />}
      {state.status === 'ready' && (
        <>
          <div className="mb-md flex items-baseline gap-sm">
            <span>{state.data.name}</span>
            {roleTag(state.data.role)}
            {state.data.identities.length > 0 && (
              <span className="font-mono text-fg-dim">{state.data.identities.join(', ')}</span>
            )}
          </div>
          <Markdown>{state.data.doc || '_(no profile doc yet)_'}</Markdown>
        </>
      )}
    </div>
  );
}

function PeopleHome() {
  const state = useAsync<PeopleView>(() => apiGet<PeopleView>('/people'), []);
  return (
    <div>
      <PageTitle>People</PageTitle>
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <ErrorNote error={state.error} />}
      {state.status === 'ready' &&
        (state.data.people.length === 0 ? (
          <p className="text-fg-dim">No people configured.</p>
        ) : (
          <ul>
            {state.data.people.map((p: PersonSummary) => (
              <li key={p.id} className="mb-sm">
                <div className="flex items-baseline gap-sm">
                  <Link to={`people/${encodeURIComponent(p.id)}`}>{p.name}</Link>
                  {roleTag(p.role)}
                  {!p.hasDoc && <span className="text-fg-dim">no doc yet</span>}
                </div>
                {p.identities.length > 0 && (
                  <div className="font-mono text-fg-dim">{p.identities.join(', ')}</div>
                )}
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

export function People({ personId }: { personId: string | null }) {
  return personId ? <PersonView id={personId} /> : <PeopleHome />;
}
