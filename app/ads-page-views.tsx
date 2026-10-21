"use client";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { adsPageViewed } from "../src/ads-pixel";

/** Counts client-side navigations for the ad pixel; the first page is counted when the pixel starts. */
export function AdsPageViews() {
  const path = usePathname(), first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    adsPageViewed(path);
  }, [path]);
  return null;
}
