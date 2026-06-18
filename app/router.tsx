import { useEffect, useState } from 'react';

// A tiny hash router (D-WD1: "hash routes … so deep links don't 404"). The
// dashboard server only ever serves index.html + assets; navigation lives
// entirely in the URL fragment, so any deep link resolves client-side.

export interface Route {
  /** Path segments after the `#/`, e.g. ['memory', 'topics', 'foo']. */
  segments: string[];
  /** Raw fragment path, e.g. 'memory/topics/foo'. */
  path: string;
  query: URLSearchParams;
}

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart = ''] = raw.split('?');
  const path = (pathPart ?? '').replace(/\/+$/, '');
  return {
    path,
    segments: path === '' ? [] : path.split('/').map(decodeURIComponent),
    query: new URLSearchParams(queryPart),
  };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(path: string): void {
  window.location.hash = `#/${path.replace(/^\/+/, '')}`;
}

export function href(path: string): string {
  return `#/${path.replace(/^\/+/, '')}`;
}
