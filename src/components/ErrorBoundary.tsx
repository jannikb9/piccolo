import { AlertTriangle } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  /** What fell over, for the message: "Piccolo", "the diff". */
  what?: string;
  /** The fallback goes away when this changes, e.g. on picking another worktree. */
  resetKey?: unknown;
};

type State = { error: Error | null; componentStack: string };

/**
 * Shows what went wrong where a render error would otherwise leave nothing but the window's
 * background. The fallback uses nothing but plain elements: it must work when the store, the
 * providers or the shared components are what failed.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: "" };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(_error: Error, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? "" });
    console.error(`${this.props.what ?? "Piccolo"} failed to render`, _error, info.componentStack);
  }

  componentDidUpdate(previous: Props) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null, componentStack: "" });
  }

  render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;
    return <Fallback error={error} componentStack={componentStack} what={this.props.what ?? "Piccolo"} retry={() => this.setState({ error: null, componentStack: "" })} />;
  }
}

function Fallback({ error, componentStack, what, retry }: { error: Error; componentStack: string; what: string; retry: () => void }) {
  const details = [`${error.name}: ${error.message}`, error.stack ?? "", componentStack && `Component stack:${componentStack}`]
    .filter(Boolean)
    .join("\n\n");
  const button =
    "h-7 shrink-0 rounded-md border border-border px-2.5 text-[12px] font-medium text-fg-muted hover:border-border-strong hover:text-fg";
  return (
    <div role="alert" className="grid h-full w-full place-items-center overflow-auto bg-bg p-8 font-sans text-fg">
      <div className="flex w-full max-w-xl flex-col gap-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-4 shrink-0 text-del" />
          <h2 className="text-[13px] font-medium">Something went wrong in {what}</h2>
        </div>
        <p className="selectable font-mono text-[12px] break-words text-fg-muted">{error.message || error.name}</p>
        <pre className="selectable max-h-72 overflow-auto rounded-md border border-border-subtle bg-bg-raised p-3 font-mono text-[11px] leading-4 text-fg-subtle">
          {details}
        </pre>
        <div className="flex items-center gap-2">
          <button type="button" onClick={retry} className={button}>
            Try again
          </button>
          <button type="button" onClick={() => location.reload()} className={button}>
            Reload
          </button>
          <button type="button" onClick={() => void navigator.clipboard?.writeText(details)} className={button}>
            Copy details
          </button>
        </div>
      </div>
    </div>
  );
}
