"use client";
import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useEffect } from "react";

// Page errors keep the portal layout (header and tabs). Layout-level failures use app/dashboard/error.tsx.
export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => { if (!error.digest) Sentry.captureException(error); }, [error]);
  return (
    <main id="main" className="content">
      <section className="empty">
        <h2>Unable to load this page</h2>
        <p role="alert">Check your connection. If the problem continues, inspect the server logs for the failing operation.</p>
        <button className="primary" onClick={reset}>Try again</button>
        <Link className="button" href="/dashboard">Back to the dashboard</Link>
      </section>
    </main>
  );
}
