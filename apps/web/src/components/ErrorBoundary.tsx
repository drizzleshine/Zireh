import { Component, type ReactNode } from "react";

/** Shows what broke instead of a blank page. Case data is in IndexedDB and is not affected. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | undefined }> {
  override state: { error: Error | undefined } = { error: undefined };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="panel" role="alert">
        <div className="error">
          <strong>This view stopped working.</strong> Your cases are saved on this computer and were not affected.
          <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.8rem" }}>{this.state.error.message}</pre>
        </div>
        <div>
          <button className="btn" onClick={() => this.setState({ error: undefined })}>
            Try again
          </button>
        </div>
      </section>
    );
  }
}
