import type { ReactNode } from 'react';
import { href as hashHref } from '../router';

// Hyperlink component (D-WD2): always renders human-readable link *text*, never
// a bare URL. Internal links target hash routes; external links open in a new
// tab with the URL tucked into the title attribute (visible on hover, not inline).

export function Link(props: {
  to?: string;
  external?: string;
  children: ReactNode;
  className?: string;
}) {
  const { to, external, children, className } = props;
  if (external) {
    return (
      <a
        href={external}
        title={external}
        target="_blank"
        rel="noreferrer noopener"
        className={className ?? 'text-tertiary hover:underline'}
      >
        {children}
      </a>
    );
  }
  return (
    <a href={hashHref(to ?? '')} className={className ?? 'text-tertiary hover:underline'}>
      {children}
    </a>
  );
}
