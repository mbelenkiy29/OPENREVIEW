"use client";
import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useEffect } from "react";
import { Mark } from "../ui/logo";
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Server errors (with a digest) were already reported by instrumentation.ts.
  useEffect(() => { if (!error.digest) Sentry.captureException(error); }, [error]);
  return (
    <div className="shell portal">
      <div className="portal-top">
        <div className="portal-identity">
          <Link className="brand" href="/dashboard" aria-label="OpenReview home"><Mark /></Link>
        </div>
      </div>
      <main id="main" className="content page">
        <header className="page-header">
          <div>
            <h1>Unable to load this workspace</h1>
            <p>The dashboard chrome stayed up so you can retry or go back.</p>
          </div>
        </header>
        <section className="empty">
          <h2>Something went wrong</h2>
          <p role="alert">
            Check your connection and access to the selected workspace. If the
            problem continues, inspect the server logs for the failing operation.
          </p>
          <button className="primary" onClick={reset}>Try again</button>
          <Link className="button" href="/dashboard">Return to overview</Link>
        </section>
      </main>
    </div>
  );
}
