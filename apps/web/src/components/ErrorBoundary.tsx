import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  /** Changing this key resets the boundary (e.g. on navigation). */
  resetKey?: string;
  compact?: boolean;
}
interface State {
  error: Error | null;
}

/**
 * Catches render errors so a single failing view shows a message instead of
 * unmounting the whole application (a blank page).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ui] render error', error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const message = this.state.error.message || String(this.state.error);
    return (
      <div className={this.props.compact ? 'p-4' : 'min-h-full flex items-center justify-center p-8'}>
        <div className="card max-w-lg w-full p-6">
          <div className="flex items-start gap-3">
            <div className="h-9 w-9 rounded-full bg-amber-50 text-amber-600 flex items-center justify-center shrink-0">
              <AlertTriangle className="h-4.5 w-4.5" />
            </div>
            <div className="min-w-0">
              <div className="font-semibold text-[15px]">Something went wrong on this page</div>
              <div className="text-[13px] text-muted mt-1">The rest of the application keeps working. Reload the page, or go back and try again. If it keeps happening, share the details below with your administrator.</div>
              <pre className="mt-3 text-[12px] bg-surface-2 border border-default rounded-lg p-3 overflow-auto max-h-40 whitespace-pre-wrap break-words">{message}</pre>
              <div className="mt-4 flex items-center gap-2">
                <button onClick={() => window.location.reload()} className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-brand-600 text-white text-[13px] font-medium hover:bg-brand-700">
                  <RefreshCw className="h-4 w-4" /> Reload
                </button>
                <button onClick={() => this.setState({ error: null })} className="inline-flex items-center h-9 px-3.5 rounded-lg border border-default bg-white text-[13px] font-medium hover:bg-surface-2">
                  Try again
                </button>
                <a href="/" className="text-[13px] text-muted hover:text-default ml-auto">
                  Go to dashboard
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
