'use client';

import * as React from 'react';

/**
 * Root error boundary — catches anything the route-level error.tsx cannot
 * (layout/runtime blow-ups). Renders its own document shell because the root
 * layout is bypassed; colors are inlined to match the dark console theme.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error('[dashboard] unrecoverable error:', error);
  }, [error]);

  return (
    <html lang="en" style={{ colorScheme: 'dark' }}>
      <body
        style={{
          margin: 0,
          backgroundColor: '#0a0a0c',
          color: '#f4f4f5',
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
        }}
      >
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            textAlign: 'center',
            padding: 24,
          }}
        >
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Console error</h1>
          <p style={{ maxWidth: 448, fontSize: 14, color: '#a1a1aa', margin: 0 }}>
            The BRIDGE registry console hit an unrecoverable error while rendering.
          </p>
          {error.digest ? (
            <p style={{ fontSize: 12, color: '#a1a1aa', margin: 0 }}>
              error digest:{' '}
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: '#f4f4f5' }}>
                {error.digest}
              </span>
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => reset()}
            style={{
              marginTop: 8,
              padding: '8px 16px',
              borderRadius: 8,
              border: '1px solid #2e2e35',
              backgroundColor: 'transparent',
              color: '#f4f4f5',
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      </body>
    </html>
  );
}
