"use client";
import * as Sentry from "@sentry/nextjs";
import { useEffect, useRef } from "react";
import type { Milestone } from "../convex/analyticsMilestones";
import { withLoadedAnalytics } from "../src/analytics-loader";
import { analyticsStartedEvent } from "../src/consent";
import { sentryDsn } from "../src/telemetry";
import { reportMilestones } from "./telemetry-actions";
import { userJotLogout } from "./userjot";

/** Ties analytics and error reports to the signed-in user and active workspace, by internal id only,
 *  and sends product milestones not yet reported. */
export function TelemetryIdentity({ userId, workspaceId, milestones = [] }: { userId: string; workspaceId?: string; milestones?: Milestone[] }) {
  const sent = useRef(""), keys = milestones.map((m) => m.key).join(",");
  useEffect(() => {
    // PostHog runs only after analytics consent, which may come later on this same page. Milestones
    // are marked reported only once PostHog has actually sent them.
    const identify = () => withLoadedAnalytics((a) => {
      a.identifyAnalytics(userId, workspaceId);
      if (keys && sent.current !== keys && a.captureMilestones(milestones)) { sent.current = keys; void reportMilestones(milestones.map((m) => m.key)); }
    });
    identify();
    window.addEventListener(analyticsStartedEvent, identify);
    if (sentryDsn) {
      Sentry.setUser({ id: userId });
      Sentry.setTag("workspace_id", workspaceId ?? "none");
    }
    return () => window.removeEventListener(analyticsStartedEvent, identify);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `keys` stands for `milestones`.
  }, [userId, workspaceId, keys]);
  return null;
}

/** A sign-out form that also forgets the user in this browser's analytics, error reports and feedback widget. */
export function SignOutForm({ action, label }: { action: () => Promise<void>; label: string }) {
  return <form action={action} onSubmit={() => {
    withLoadedAnalytics((a) => a.resetAnalytics());
    if (sentryDsn) Sentry.setUser(null);
    userJotLogout();
  }}><button className="small">{label}</button></form>;
}
