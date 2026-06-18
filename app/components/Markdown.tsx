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
  // Constrain headings/code to the terminal type scale.
  h1: ({ children }) => <h1 className="text-headline-lg font-bold text-fg mt-lg mb-md">{children}</h1>,
  h2: ({ children }) => (
    <h2 className="text-headline-md font-semibold text-secondary mt-lg mb-sm">{children}</h2>
  ),
  h3: ({ children }) => <h3 className="text-body-lg font-semibold text-fg mt-md mb-sm">{children}</h3>,
  p: ({ children }) => <p className="my-sm text-fg-muted">{children}</p>,
  ul: ({ children }) => <ul className="my-sm list-disc pl-lg text-fg-muted">{children}</ul>,
  ol: ({ children }) => <ol className="my-sm list-decimal pl-lg text-fg-muted">{children}</ol>,
  li: ({ children }) => <li className="my-xs">{children}</li>,
  code: ({ children }) => (
    <code className="rounded-sm bg-surface-elevated px-xs py-0 text-tertiary">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="my-sm overflow-x-auto rounded-md bg-bg-dark p-md text-body-sm">{children}</pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-sm border-l-2 border-border pl-md text-fg-dim italic">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-md border-border" />,
  table: ({ children }) => (
    <table className="my-sm w-full border-collapse text-body-sm">{children}</table>
  ),
  th: ({ children }) => (
    <th className="border border-border px-sm py-xs text-left text-fg">{children}</th>
  ),
  td: ({ children }) => <td className="border border-border px-sm py-xs">{children}</td>,
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-body-md leading-relaxed">
      <ReactMarkdown components={components}>{children}</ReactMarkdown>
    </div>
  );
}
