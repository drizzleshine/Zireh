import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** Shows what broke instead of a blank page. Case data is in IndexedDB and is not affected. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | undefined }> {
  override state: { error: Error | undefined } = { error: undefined };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="mx-auto grid max-w-xl gap-4 px-4 py-16" role="alert">
        <div className="grid gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-5">
          <strong>This view stopped working.</strong>
          <p className="text-sm text-muted-foreground">Your cases are saved in this browser and were not affected.</p>
          <pre className="max-h-48 overflow-auto rounded bg-background p-2 text-xs whitespace-pre-wrap">{this.state.error.message}</pre>
        </div>
        <div>
          <Button variant="outline" onClick={() => this.setState({ error: undefined })}>
            Try again
          </Button>
        </div>
      </section>
    );
  }
}
