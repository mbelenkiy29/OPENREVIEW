// Reddit Pixel (Reddit Ads → Events Manager): tells Reddit Ads which visits and sign-ups came from our
// ads on Reddit. It sets cookies, so like PostHog it starts only after the visitor accepts the
// analytics banner (src/analytics.ts starts it). Off unless the pixel ID is set when the web app is
// built, so self-hosted installs send nothing, and off on Vercel preview deployments.
import { isNewSignup } from "./ads-pixel";

export const redditPixelId = process.env.NEXT_PUBLIC_VERCEL_ENV === "preview" ? undefined : process.env.NEXT_PUBLIC_REDDIT_PIXEL_ID || undefined;

type Rdt = ((...args: unknown[]) => void) & { callQueue: IArguments[]; sendEvent?: (...args: unknown[]) => void };
declare global {
  interface Window { rdt?: Rdt }
}

// The pixel has no consent switch of its own, so events go out only between start and stop.
let running = false;

/** Events Manager's base code for this pixel, run from this bundle rather than as an inline script: the
 *  page CSP allows only nonced inline scripts, while 'strict-dynamic' lets this code add pixel.js
 *  (src/security-headers.ts). No advanced-matching identifiers are passed to init. */
function baseCode(pixelId: string) {
  const rdt: Rdt = Object.assign(function () {
    // pixel.js sets sendEvent once loaded and replays the queued `arguments` objects, as the snippet stores them.
    // eslint-disable-next-line prefer-rest-params
    if (rdt.sendEvent) rdt.sendEvent(...arguments); else rdt.callQueue.push(arguments);
  }, { callQueue: [] as IArguments[] });
  window.rdt = rdt;
  const pixel = document.createElement("script");
  pixel.async = true;
  pixel.src = "https://www.redditstatic.com/ads/pixel.js";
  document.head.append(pixel);
  rdt("init", pixelId);
}

/** After consent: loads the pixel once per page and counts the current page. */
export function startRedditPixel() {
  if (!redditPixelId) return;
  if (!window.rdt) baseCode(redditPixelId);
  running = true;
  redditPageVisit();
}

/** After a refusal: sends nothing more from this page; clearAnalyticsStorage (src/consent.ts) removes its cookies. */
export const stopRedditPixel = () => { running = false; };

/** Counts a page. The event carries no URL of ours, and the pixel's requests get only this site's
 *  origin as their Referer (Referrer-Policy in src/security-headers.ts). */
export function redditPageVisit() {
  if (running) window.rdt?.("track", "PageVisit");
}

/** Reports a new account to the pixel, by the same rule as measureSignup (src/ads-pixel.ts): once per
 *  account, never on a later sign-in. The conversion id lets Reddit drop a repeat if marking the
 *  milestone reported failed, or the same sign-up arriving from its Conversions API. */
export function measureRedditSignup(milestones: { key: string; at: number }[], userId: string, now = Date.now()) {
  if (!running || !isNewSignup(milestones, now) || typeof window.rdt !== "function") return false;
  window.rdt("track", "SignUp", { conversionId: `signed_up:${userId}` });
  return true;
}
