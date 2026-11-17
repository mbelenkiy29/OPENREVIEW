// Map Convex webhook-action failures to HTTP statuses. Providers retry 5xx; 401 means "do not retry
// this signature". ConvexHttpClient wraps thrown errors as "Uncaught Error: <message>".
export function webhookErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/^.*Uncaught Error: /s, "").split("\n")[0];
}

export function providerWebhookResponse(error: unknown) {
  const message = webhookErrorMessage(error);
  if (/Unauthorized service|Invalid webhook signature/.test(message))
    return new Response("Invalid or unauthorized delivery", { status: 401 });
  if (/Invalid JSON|Invalid delivery|event header and signed body/.test(message))
    return new Response("Invalid delivery", { status: 400 });
  return new Response("Delivery unavailable", { status: 503 });
}

export function originWebhookResponse(error: unknown) {
  const message = webhookErrorMessage(error);
  if (/Unauthorized service|Invalid Origin signature|delivery identity mismatch|installation identity mismatch/.test(message))
    return new Response("Invalid or unauthorized Origin delivery", { status: 401 });
  if (/Invalid Origin (JSON body|webhook configuration)|Invalid Origin JSON/.test(message))
    return new Response("Invalid Origin delivery", { status: 400 });
  return new Response("Origin delivery unavailable", { status: 503 });
}
