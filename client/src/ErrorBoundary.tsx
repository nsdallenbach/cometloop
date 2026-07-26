import React, { Component } from 'react';
import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@databricks/appkit-ui/react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error);
    console.error('Error details:', errorInfo);
    this.setState({
      error,
      errorInfo,
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-background p-4">
          <Card className="max-w-2xl mx-auto mt-8">
            <CardHeader>
              <CardTitle className="text-destructive">Something went wrong</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <p className="text-sm">The console hit an unexpected error. Reloading usually fixes it — your data is safe on the server.</p>
                <button
                  className="rounded bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
                  onClick={() => window.location.reload()}
                >
                  Reload
                </button>
                {import.meta.env.DEV && (
                  <>
                    <pre className="bg-muted p-3 rounded text-sm overflow-auto">{this.state.error?.toString()}</pre>
                    {this.state.errorInfo && (
                      <pre className="bg-muted p-3 rounded text-sm overflow-auto">{this.state.errorInfo.componentStack}</pre>
                    )}
                    {this.state.error?.stack && (
                      <pre className="bg-muted p-3 rounded text-sm overflow-auto max-h-96">{this.state.error.stack}</pre>
                    )}
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
