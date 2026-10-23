"use client";
// Loads the landing page's motion (motion.tsx) in the browser only, as its own chunk, so GSAP is
// fetched after the page is interactive and never holds up the first paint or hydration.
import dynamic from "next/dynamic";

export const LandingMotion = dynamic(() => import("./motion"), { ssr: false });
