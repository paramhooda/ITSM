import { Component, Suspense, type ReactNode } from 'react';
import { LoadingBlock } from '@/components/ui';

class Boundary extends Component<{ fallback?: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback ?? null : this.props.children;
  }
}

/** Suspense + error boundary wrapper for lazily loaded components owned by other modules. */
export function LazyBlock({ children, fallback = null, loading }: { children: ReactNode; fallback?: ReactNode; loading?: ReactNode }) {
  return (
    <Boundary fallback={fallback}>
      <Suspense fallback={loading ?? <LoadingBlock />}>{children}</Suspense>
    </Boundary>
  );
}
