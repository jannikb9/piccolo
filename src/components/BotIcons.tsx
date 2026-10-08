import type { SVGProps } from "react";

// Robots for the agent buttons, drawn like Lucide's icons (24-unit grid, 2-unit round strokes) so
// they sit beside them: a bot in glasses inspects the branch, a bot in a hard hat gets to work on it.

function BotIcon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

/** A bot in glasses, for asking for a review. */
export function ReviewerBot(props: SVGProps<SVGSVGElement>) {
  return (
    <BotIcon {...props}>
      <path d="M12 8V4H8" />
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M2 14h2M20 14h2" />
      <circle cx="9" cy="14" r="2" />
      <circle cx="15" cy="14" r="2" />
      <path d="M11 14h2" />
    </BotIcon>
  );
}

/** A bot in a hard hat, for sending it comments to address. */
export function BuilderBot(props: SVGProps<SVGSVGElement>) {
  return (
    <BotIcon {...props}>
      <path d="M6 9V8a6 6 0 0 1 12 0v1" />
      <path d="M12 2v4" />
      <path d="M3 9h18" />
      <rect x="5" y="12" width="14" height="8" rx="2" />
      <path d="M9 15v2M15 15v2" />
    </BotIcon>
  );
}
