"use client";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { adsPageViewed } from "../src/ads-pixel";
import { redditPageVisit } from "../src/reddit-pixel";

/** Counts client-side navigations for the ad pixels; the first page is counted when each pixel starts. */
export function AdsPageViews() {
  const path = usePathname(), first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    adsPageViewed(path);
    redditPageVisit();
  }, [path]);
  return null;
}
