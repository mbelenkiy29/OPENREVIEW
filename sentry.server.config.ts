// Server (Node.js) error tracking; loaded by instrumentation.ts only when a DSN is set.
import * as Sentry from "@sentry/nextjs";
import { scrubBreadcrumb, scrubSentryEvent, scrubSentryTransaction, sentryDataCollection, sentryDsn, telemetryEnvironment, tracesSampleRate } from "./src/telemetry";

Sentry.init({
  dsn: sentryDsn,
  environment: telemetryEnvironment,
  tracesSampleRate: tracesSampleRate(),
  dataCollection: sentryDataCollection,
  beforeSend: scrubSentryEvent,
  beforeSendTransaction: scrubSentryTransaction,
  beforeBreadcrumb: scrubBreadcrumb,
});
