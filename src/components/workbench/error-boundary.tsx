"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";

interface Props {
  /** Name of the region, shown in the fallback ("Chart", "SQL console"...). */
  label: string;
  children: React.ReactNode;
  /** Changing this value resets the boundary (e.g. the active dataset). */
  resetKey?: unknown;
}

interface State {
  error: Error | null;
}

/**
 * Panel-level error boundary: a rendering failure in one panel (e.g. a chart choking on
 * unexpected data) is contained and recoverable without reloading the workbench.
 */
export class PanelErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[QuantAgent] ${this.props.label} crashed`, error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="flex h-full min-h-32 flex-col items-center justify-center gap-2 p-6 text-center">
        <AlertTriangle className="size-5 text-warning" />
        <div className="text-sm font-medium">{this.props.label} failed to render</div>
        <pre className="max-w-lg whitespace-pre-wrap break-words text-[11px] text-muted-foreground">{this.state.error.message}</pre>
        <Button size="sm" variant="outline" onClick={() => this.setState({ error: null })}>
          <RotateCcw /> Try again
        </Button>
      </div>
    );
  }
}
