// OpenAI Ads measurement pixel (https://developers.openai.com/ads/measurement-pixel): tells Ads Manager
// which visits and sign-ups came from our ads in ChatGPT. It sets cookies, so like PostHog it starts
// only after the visitor accepts the analytics banner (src/analytics.ts starts it). Off unless the
// pixel ID is set when the web app is built, so self-hosted installs send nothing.
export const adsPixelId = process.env.NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID || undefined;

declare global {
  interface Window { oaiq?: (...args: unknown[]) => void }
}

/** Ads Manager's setup code for this pixel, run from this bundle rather than as an inline script: the
 *  page CSP allows only nonced inline scripts, while 'strict-dynamic' lets this code add the SDK's
 *  (src/security-headers.ts). Console logging only in development. */
function setupCode(pixelId: string) {
  const queue = Object.assign(function () {
    // The SDK replays the queued `arguments` objects, as the snippet stores them.
    // eslint-disable-next-line prefer-rest-params
    queue.q.push(arguments);
  }, { q: [] as IArguments[] });
  window.oaiq = queue;
  const sdk = document.createElement("script");
  sdk.async = true;
  sdk.src = "https://bzrcdn.openai.com/sdk/oaiq.min.js";
  document.head.append(sdk);
  window.oaiq("init", { pixelId, debug: process.env.NODE_ENV !== "production" });
}

/** After consent: loads the pixel once and counts the current page. */
export function startAdsPixel() {
  if (!adsPixelId) return;
  if (!window.oaiq) setupCode(adsPixelId);
  // Undoes a denial the pixel stored when this visitor declined earlier.
  window.oaiq?.("consent", true);
  adsPageViewed(location.pathname);
}

/** After a refusal: stops the pixel in this page and has it remove its cookies. */
export const stopAdsPixel = () => window.oaiq?.("consent", false);

/** Counts a page by its first path segment only, so ids and invite tokens in URLs never reach the pixel. */
export function adsPageViewed(path: string) {
  const id = `/${path.split("/")[1] ?? ""}`;
  window.oaiq?.("measure", "page_viewed", { type: "contents", contents: [{ id, name: id, content_type: "page" }] });
}

/** Reports a new account to the pixel. The `signed_up` milestone stays pending only until it is
 *  reported (convex/analyticsMilestones.ts), so this runs once per account, not on every sign-in;
 *  accounts older than a day never count, nor do ones from before the pixel existed. The event id
 *  lets Ads Manager drop a repeat if marking the milestone reported failed. */
export function measureSignup(milestones: { key: string; at: number }[], userId: string, now = Date.now()) {
  const signedUp = milestones.find((m) => m.key === "signed_up");
  if (!signedUp || now - signedUp.at > 86_400_000 || typeof window.oaiq !== "function") return false;
  window.oaiq("measure", "registration_completed", { type: "customer_action" }, { event_id: `signed_up:${userId}` });
  return true;
}
