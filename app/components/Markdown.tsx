import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';

// Sanitized markdown renderer (D-WD3/D-WD5). react-markdown does NOT render raw
// HTML by default (no rehype-raw here), so embedded <script>/<img onerror=…> in
// untrusted memory/message content is rendered as inert text — no stored-HTML or
// script injection. Links render as human-readable text with the URL hidden in
// the title (D-WD2: never show a bare URL); they open in a new tab.

const components: Components = {
  a({ href, children }) {
    return (
      <a
        href={href}
        title={href}
        target="_blank"
        rel="noreferrer noopener"
        className="text-tertiary hover:underline"
      >
        {children}
      </a>
    );
  },
  // Single type size: headings differ by weight / case / a rule, never size.
  // Margins are whole/half rows so rendered markdown keeps the terminal rhythm.
  h1: ({ children }) => (
    <h1 className="mt-md mb-sm font-bold uppercase tracking-[0.04em] text-fg">{children}</h1>
  ),
  h2: ({ children }) => <h2 className="mt-md mb-sm font-bold text-secondary">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-md mb-0 font-bold text-fg">› {children}</h3>,
  p: ({ children }) => <p className="my-sm text-fg-muted">{children}</p>,
  ul: ({ children }) => <ul className="my-sm list-none text-fg-muted">{children}</ul>,
  ol: ({ children }) => <ol className="my-sm list-decimal pl-lg text-fg-muted">{children}</ol>,
  li: ({ children }) => (
    <li className="before:text-fg-dim before:content-['-_'] [ol_&]:before:content-none">
      {children}
    </li>
  ),
  code: ({ children }) => <code className="bg-surface-elevated px-xs text-primary">{children}</code>,
  pre: ({ children }) => (
    <pre className="my-sm overflow-x-auto bg-bg-dark p-sm">{children}</pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-sm pl-md text-fg-dim italic">{children}</blockquote>
  ),
  hr: () => <div className="my-md" aria-hidden />,
  table: ({ children }) => <table className="my-sm w-full">{children}</table>,
  th: ({ children }) => <th className="pr-md py-0 text-left text-fg-dim">{children}</th>,
  td: ({ children }) => <td className="pr-md py-0">{children}</td>,
};

export function Markdown({ children }: { children: string }) {
  return (
    <div>
      <ReactMarkdown components={components}>{children}</ReactMarkdown>
    </div>
  );
}
