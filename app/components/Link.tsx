import type { ReactNode } from 'react';
import { href as hashHref } from '../router';

// Hyperlink component (D-WD2): always renders human-readable link *text*, never
// a bare URL. Internal links target hash routes; external links open in a new
// tab with the URL tucked into the title attribute (visible on hover, not inline).

/**
 * An action rendered as a hyperlink, not a button (DESIGN.md Components): blue
 * link text, underline on hover, no border/fill/box. `active` underlines it (for
 * current nav/tab); `bracketed` wraps the label in `[ … ]` for a terminal cue.
 */
export function LinkButton({
  onClick,
  children,
  active = false,
  disabled = false,
  bracketed = false,
  type = 'button',
  className = '',
  title,
}: {
  onClick?: () => void;
  children: ReactNode;
  active?: boolean;
  disabled?: boolean;
  bracketed?: boolean;
  type?: 'button' | 'submit';
  className?: string;
  title?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        'inline text-left text-primary hover:underline',
        active ? 'underline' : '',
        disabled ? 'cursor-default text-fg-dim no-underline hover:no-underline' : '',
        className,
      ].join(' ')}
    >
      {bracketed ? <>[&nbsp;{children}&nbsp;]</> : children}
    </button>
  );
}

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
