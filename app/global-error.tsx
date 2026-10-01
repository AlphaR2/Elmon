"use client"; // Error boundaries must be Client Components

// Last-resort screen when the whole layout fails. It renders its own document without the app's styles,
// so styles are inline.
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", background: "#0b0c0e", color: "#eceef1", fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif" }}>
        <title>Elmon Analytics: error</title>
        <div style={{ textAlign: "center", padding: 24, maxWidth: 420 }}>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Elmon hit an error</div>
          <p style={{ color: "#a1a9b5", fontSize: 14, lineHeight: 1.5 }}>
            Your runs and results are safe. Try again, or reload the page.
            {error.digest ? <span style={{ display: "block", color: "#6b7380", fontSize: 12, marginTop: 8 }}>Reference: {error.digest}</span> : null}
          </p>
          <button
            onClick={() => retry()}
            style={{ marginTop: 12, height: 36, padding: "0 16px", borderRadius: 6, border: 0, background: "#3987e5", color: "#fff", fontWeight: 500, cursor: "pointer" }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
