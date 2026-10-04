import type { MouseEvent, ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { openLink } from "../lib/markdown";
import { cn } from "../lib/utils";

/**
 * Raw HTML in a comment shows as the text it is: agents write `Array<string>` without backticks,
 * and dropping the "tag" would lose words. Only `<br>` is a line break, as the editor writes one
 * in a table cell.
 */
function remarkHtmlAsText() {
  type Node = { type: string; value?: string; children?: Node[] };
  const visit = (node: Node) => {
    if (node.type === "html") node.type = /^<br\s*\/?>$/i.test(node.value ?? "") ? "break" : "text";
    node.children?.forEach(visit);
  };
  return visit;
}

/** Comments are short: a heading is just a bold line. */
const Heading: Components["h1"] = ({ children }) => (
  <p>
    <strong>{children}</strong>
  </p>
);

const components: Components = {
  h1: Heading,
  h2: Heading,
  h3: Heading,
  h4: Heading,
  h5: Heading,
  h6: Heading,
  // Links open in the browser; the app's window never navigates.
  a: ({ href, children }) => <Link href={href}>{children}</Link>,
  // Remote images in a comment would load from anywhere; screenshots are attachments instead.
  img: ({ src, alt }) => (typeof src === "string" ? <Link href={src}>{alt || src}</Link> : null),
};

function Link({ href, children }: { href?: string; children: ReactNode }) {
  return (
    <a
      href={href}
      title={href}
      onClick={(e: MouseEvent) => {
        e.preventDefault();
        if (href) openLink(href);
      }}
    >
      {children}
    </a>
  );
}

/**
 * A comment's body as GitHub renders it: GitHub-flavored Markdown with newlines kept as line
 * breaks, so comments written as plain text read as before.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("markdown selectable", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks, remarkHtmlAsText]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
