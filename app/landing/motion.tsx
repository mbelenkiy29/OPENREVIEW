"use client";
// The landing page's motion (DESIGN.md, "Landing motion"), built with GSAP and loaded after hydration
// by motion-loader.tsx. It works on the server-rendered page through its classes and data-* hooks.
// Anything already on screen when an effect is set up is left alone, and only content still below the
// fold is put in its starting state, so nothing the visitor has seen disappears and nothing flashes.
// Under reduced motion it does nothing, and the page as rendered is the final state of every effect.
import gsap from "gsap";
import { ScrollSmoother } from "gsap/ScrollSmoother";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(useGSAP, ScrollTrigger, ScrollSmoother, SplitText);

// Smooth scrolling, parallax, the hero window's settle and the pinned steps are for desktop
// pointers. Touch screens keep native scrolling and get the reveals only.
const desktopQuery = "(min-width: 1024px) and (pointer: fine)";
const motionQuery = "(prefers-reduced-motion: no-preference)";
const ease = "expo.out";
const typeSpeed = 0.022; // seconds per character typed in the terminal

// Reveals fade with opacity, never visibility, so content waiting below the fold stays in the
// accessibility tree and the tab order; focusing it scrolls it into view, which reveals it.

/** True when the element starts below the visible part of the page. */
const below = (el: Element) => el.getBoundingClientRect().top > window.innerHeight;

/** Reveals text line by line from behind masks (or character by character, rising and fading in),
 *  then undoes the split so the heading is plain text again. */
function reveal(text: Element, vars: gsap.TweenVars = {}, chars = false) {
  const split = SplitText.create(text, chars ? { type: "words,chars", ignore: ".cta-dot" } : { type: "lines", mask: "lines", linesClass: "split-line" });
  const { onComplete, ...rest } = vars;
  return gsap.from(chars ? split.chars : split.lines, {
    ...(chars ? { yPercent: 60, opacity: 0, stagger: 0.028 } : { yPercent: 110, stagger: 0.09 }), duration: 1.1, ease, ...rest,
    onComplete() { split.revert(); if (typeof onComplete === "function") onComplete(); },
  });
}

/** Items rise in turn as they reach the viewport; items entering together share one stagger. */
function rise(items: Element[]) {
  if (!items.length) return;
  gsap.set(items, { opacity: 0, y: 28 });
  ScrollTrigger.batch(items, { start: "top 92%", once: true, onEnter: (entered) => gsap.to(entered, { opacity: 1, y: 0, duration: 0.9, ease, stagger: 0.07, overwrite: true }) });
}

/** Builds every effect for the current media conditions and returns what undoes the non-GSAP parts.
 *  What the first screen needs is set up at once; each section further down is set up in its own
 *  idle moment, so the work never holds the main thread for long. `moved` is called on every frame
 *  of smoothed scrolling. */
function choreograph(root: HTMLElement, desktop: boolean, context: gsap.Context, moved: () => void) {
  const all = <T extends Element = HTMLElement>(selector: string) => [...root.querySelectorAll<T>(selector)];
  const header = root.querySelector<HTMLElement>(":scope > .site-header");
  const cleanup: (() => void)[] = [];

  // Smooth scrolling. The header is fixed above the smoothed content while it runs (globals.css,
  // .landing.is-smooth), so the class goes on before the smoother measures the page.
  let smoother: ScrollSmoother | undefined, anchoring: Element | null = null;
  if (desktop) {
    root.classList.add("is-smooth");
    smoother = ScrollSmoother.create({
      wrapper: "#smooth-wrapper", content: "#smooth-content", smooth: 1.2, effects: true,
      // Keyboard focus that lands off-screen is brought into view, except for an anchor target,
      // which the click handler below scrolls to smoothly.
      onFocusIn: (_self, event) => event.target !== anchoring,
      onUpdate: moved,
    });
    // Find in page, scrollIntoView and test drivers scroll the nearest scrollable box, which is the
    // smoother's fixed wrapper, and the smoother resets it on the next focus, so a click right after
    // would land somewhere else. Hand that scroll to the page instead, without moving anything on
    // screen: when the wrapper scrolls, and before any press or focus can reset it.
    const wrapper = document.getElementById("smooth-wrapper");
    const adopt = () => {
      if (!wrapper || !smoother || (!wrapper.scrollTop && !wrapper.scrollLeft)) return;
      const by = wrapper.scrollTop;
      wrapper.scrollTop = wrapper.scrollLeft = 0;
      smoother.scrollTop(smoother.scrollTop() + by);
    };
    wrapper?.addEventListener("scroll", adopt);
    document.addEventListener("pointerdown", adopt, true);
    document.addEventListener("focusin", adopt, true);
    cleanup.push(() => {
      wrapper?.removeEventListener("scroll", adopt);
      document.removeEventListener("pointerdown", adopt, true);
      document.removeEventListener("focusin", adopt, true);
      smoother?.kill();
      root.classList.remove("is-smooth");
    });
  }

  // How it works (desktop): the section holds still while a track draws across the four steps and
  // each one comes up as the track reaches it. It is set up first because its pin adds scroll
  // length that every later position depends on.
  const how = root.querySelector<HTMLElement>(".how-inner"), track = how?.querySelector(".steps-track");
  const steps = how ? [...how.querySelectorAll<HTMLElement>(".steps > li")] : [];
  if (how && desktop && track && steps.length) {
    const tl = gsap.timeline({ scrollTrigger: { trigger: how, start: "center center", end: "+=110%", pin: true, scrub: 0.6 } });
    tl.fromTo(track, { scaleX: 0 }, { scaleX: 1, ease: "none", duration: steps.length }, 0);
    steps.forEach((step, i) => tl.fromTo(step.children, { opacity: 0.3, y: 18 }, { opacity: 1, y: 0, ease: "power2.out", duration: 0.55, stagger: 0.08 }, i + 0.05));
  }

  // In-page links (Features, How it works, Pricing) glide to their section below the header, and
  // move keyboard focus there as a native jump would.
  const offset = () => (header?.offsetHeight ?? 0) + 24;
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element | null)?.closest?.<HTMLAnchorElement>("a[href*='#']");
    if (!link || link.origin !== location.origin || link.pathname !== location.pathname || !link.hash) return;
    const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
    if (!target || !root.contains(target)) return;
    event.preventDefault();
    history.pushState(null, "", link.hash);
    anchoring = target;
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
    if (smoother) smoother.scrollTo(target, true, `top ${offset()}px`);
    else target.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  document.addEventListener("click", onClick, true);
  cleanup.push(() => document.removeEventListener("click", onClick, true));

  // Header: steps aside while reading down, returns on the way back up or when focused, gains its
  // hairline once the page has moved, and draws reading progress along its bottom edge.
  if (header) {
    let hidden = false;
    const hide = (on: boolean) => {
      if (on === hidden) return;
      hidden = on;
      gsap.to(header, on ? { yPercent: -100, duration: 0.35, ease: "power2.in", overwrite: true } : { yPercent: 0, duration: 0.6, ease, overwrite: true });
    };
    header.classList.toggle("is-scrolled", window.scrollY > 4);
    ScrollTrigger.create({
      start: 0, end: "max",
      onUpdate(self) {
        const y = self.scroll();
        header.classList.toggle("is-scrolled", y > 4);
        hide(self.direction === 1 && y > 320 && !header.contains(document.activeElement));
      },
    });
    const show = () => hide(false);
    header.addEventListener("focusin", show);
    const progress = header.querySelector(".scroll-progress");
    if (progress) gsap.fromTo(progress, { scaleX: 0 }, { scaleX: 1, ease: "none", scrollTrigger: { start: 0, end: "max", scrub: true } });
    cleanup.push(() => { header.removeEventListener("focusin", show); header.classList.remove("is-scrolled"); gsap.set(header, { clearProps: "transform" }); });
  }

  // The hero window settles from 94% to full size as it scrolls into place. Its resting 94% is in
  // globals.css under the same media query, so nothing jumps when this takes over.
  const heroWindow = root.querySelector(".hero-stage .replica");
  if (desktop && heroWindow) gsap.fromTo(heroWindow, { scale: 0.94 }, { scale: 1, ease: "none", transformOrigin: "50% 0%", scrollTrigger: { trigger: heroWindow, start: 0, end: "top 18%", scrub: true } });

  // Primary calls to action lean a few pixels toward the pointer.
  if (desktop) for (const button of all<HTMLAnchorElement>(".hero-actions .primary, .cta-actions .primary")) {
    const x = gsap.quickTo(button, "x", { duration: 0.5, ease: "power3" }), y = gsap.quickTo(button, "y", { duration: 0.5, ease: "power3" });
    const move = (event: PointerEvent) => {
      const box = button.getBoundingClientRect();
      x(gsap.utils.clamp(-6, 6, (event.clientX - box.left - box.width / 2) * 0.2));
      y(gsap.utils.clamp(-6, 6, (event.clientY - box.top - box.height / 2) * 0.3));
    };
    const leave = () => { x(0); y(0); };
    button.addEventListener("pointermove", move);
    button.addEventListener("pointerleave", leave);
    cleanup.push(() => { button.removeEventListener("pointermove", move); button.removeEventListener("pointerleave", leave); gsap.set(button, { clearProps: "transform" }); });
  }

  // Below the fold, in page order. Each step reads positions before it writes anything.
  const later: (() => void)[] = [];

  // Feature rows: the window slides in from its own side while the copy cascades in beside it.
  for (const row of all(".feature")) later.push(() => {
    if (!below(row)) return;
    const copy = row.querySelector(".feature-copy"), stage = row.querySelector(".stage"), win = stage?.querySelector(".replica");
    const side = row.classList.contains("reverse") ? -1 : 1;
    const tl = gsap.timeline({ defaults: { ease, duration: 1.1 }, scrollTrigger: { trigger: row, start: "top 78%", once: true } });
    if (stage) tl.from(stage, { opacity: 0, y: 56 }, 0);
    if (win) tl.from(win, { x: side * (desktop ? 72 : 24), duration: 1.4 }, 0.08);
    const [eyebrow, heading, ...rest] = copy ? [...copy.children] : [];
    if (eyebrow) tl.from(eyebrow, { opacity: 0, y: 14, duration: 0.8 }, 0.15);
    if (heading) tl.add(reveal(heading), 0.22);
    if (rest.length) tl.from(rest, { opacity: 0, y: 20, stagger: 0.08 }, 0.45);
  });

  // Headings reveal line by line, single items rise, lists bring their children in turn.
  for (const heading of all("[data-split]")) later.push(() => { if (below(heading)) reveal(heading, { scrollTrigger: { trigger: heading, start: "top 88%", once: true } }); });
  for (const item of all("[data-reveal]")) later.push(() => { if (below(item)) gsap.from(item, { opacity: 0, y: 24, duration: 1, ease, scrollTrigger: { trigger: item, start: "top 92%", once: true } }); });
  for (const list of all("[data-stagger]")) later.push(() => rise([...list.children].filter(below)));
  if (!desktop) later.push(() => rise(steps.filter(below)));

  // The terminal types its commands one after another, a monospace character per step, with a caret;
  // each line's prompt appears as its turn comes.
  const terminal = root.querySelector<HTMLElement>(".terminal");
  if (terminal) later.push(() => {
    if (!below(terminal)) return;
    const caret = terminal.querySelector<HTMLElement>(".caret"), prompts = terminal.querySelectorAll("code > span:first-child");
    const tl = gsap.timeline({ scrollTrigger: { trigger: terminal, start: "top 82%", once: true }, onComplete: () => terminal.classList.add("is-typed") });
    tl.from(terminal, { opacity: 0, y: 40, duration: 1, ease });
    gsap.set(prompts, { opacity: 0 });
    terminal.querySelectorAll<HTMLElement>(".cmd").forEach((cmd, i) => {
      const n = cmd.textContent?.length ?? 0, duration = n * typeSpeed, typing = `steps(${n})`;
      tl.set(prompts[i], { opacity: 1 }, i ? ">0.22" : "-=0.45");
      tl.fromTo(cmd, { clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)", duration, ease: typing }, "<0.12");
      if (caret) tl.set(caret, { autoAlpha: 1, x: cmd.offsetLeft, y: cmd.offsetTop }, "<").to(caret, { x: cmd.offsetLeft + cmd.offsetWidth, duration, ease: typing }, "<");
    });
  });
  cleanup.push(() => terminal?.classList.remove("is-typed"));

  // The closing line rises a character at a time, then its full stop lands as the ember dot from
  // the logo: a finding on a line.
  const cta = root.querySelector<HTMLElement>(".cta h2");
  if (cta) later.push(() => {
    if (!below(cta)) return;
    const dot = cta.querySelector(".cta-dot");
    const tl = gsap.timeline({ scrollTrigger: { trigger: cta, start: "top 85%", once: true } });
    tl.add(reveal(cta, { duration: 0.9 }, true));
    if (dot) tl.from(dot, { y: "-1.4em", opacity: 0, duration: 0.9, ease: "bounce.out" }, "-=0.35");
  });

  // One step per idle moment (or a frame later where the browser has no idle callbacks). Steps run
  // through the GSAP context so reverting it undoes them too.
  const hasIdle = typeof window.requestIdleCallback === "function";
  const idle = (run: () => void) => hasIdle ? window.requestIdleCallback(run, { timeout: 400 }) : window.setTimeout(run, 16);
  const cancelIdle = (id: number) => hasIdle ? window.cancelIdleCallback(id) : window.clearTimeout(id);
  let pending = 0;
  const next = () => {
    const step = later.shift();
    if (!step) return;
    context.add(step);
    pending = idle(next);
  };
  pending = idle(next);
  cleanup.push(() => cancelIdle(pending));

  // Layout changes that the scroll positions depend on (demos that grow on phones) re-measure once
  // things settle, never on every frame. ScrollSmoother watches its own content.
  const remeasure = gsap.delayedCall(0.25, () => ScrollTrigger.refresh()).pause();
  const observer = new ResizeObserver(() => remeasure.restart(true));
  const main = root.querySelector("main");
  if (main && !smoother) observer.observe(main);
  cleanup.push(() => { observer.disconnect(); remeasure.kill(); });

  return () => cleanup.forEach((undo) => undo());
}

/** The block the reader is looking at: the first one still showing below the header, and where it is. */
function readingPlace(root: HTMLElement) {
  const line = Math.max(0, root.querySelector(":scope > .site-header")?.getBoundingClientRect().bottom ?? 0);
  for (const el of root.querySelectorAll("main > * > :not(.pin-spacer), main > * > .pin-spacer > *, .site-footer")) {
    const box = el.getBoundingClientRect();
    if (box.bottom > line) return { el, top: box.top };
  }
}

export default function LandingMotion() {
  useGSAP(() => {
    const root = document.querySelector<HTMLElement>(".landing");
    if (!root) return;
    ScrollTrigger.config({ ignoreMobileResize: true });
    let media: gsap.MatchMedia | undefined, live = true;
    // Resizing reflows the page, and a change of conditions (the window crossing the desktop width,
    // reduced motion switched on or off) rebuilds everything; either way ScrollTrigger's refresh
    // scrolls to the top while it measures. So the reader's place is noted as they scroll (smoothed
    // scrolling on each frame the smoother moves, native scrolling on each scroll event; about 0.1 ms
    // a note), held from the moment the width or a condition changes, and put back after the refresh
    // that follows. Height-only resizes, like a phone's address bar, don't hold it.
    let place: ReturnType<typeof readingPlace>, held = false, release = 0, width = window.innerWidth;
    const remember = () => { if (!held) place = readingPlace(root); };
    const scrolled = () => { if (!ScrollSmoother.get()) remember(); };
    const hold = () => {
      held = true;
      window.clearTimeout(release);
      release = window.setTimeout(() => { held = false; }, 1500); // if no refresh follows
    };
    const resized = () => { if (window.innerWidth !== width) { width = window.innerWidth; hold(); } };
    const conditions = [desktopQuery, motionQuery].map((query) => window.matchMedia(query));
    const restore = () => requestAnimationFrame(() => {
      if (!held) return;
      held = false;
      window.clearTimeout(release);
      if (!place?.el.isConnected) return;
      const by = place.el.getBoundingClientRect().top - place.top, smoother = ScrollSmoother.get();
      if (smoother) smoother.scrollTop(smoother.scrollTop() + by);
      else window.scrollBy(0, by);
    });
    window.addEventListener("scroll", scrolled, { passive: true });
    window.addEventListener("resize", resized);
    conditions.forEach((query) => query.addEventListener("change", hold));
    ScrollTrigger.addEventListener("refresh", restore);
    // Fonts decide where heading lines break, so the splits wait for them. Content below the fold is
    // still below it then; whatever the visitor reached first is simply left as rendered.
    void document.fonts.ready.then(() => {
      if (!live) return;
      // GSAP runs this whenever any condition matches, and again when either one changes.
      media = gsap.matchMedia();
      media.add({ desktop: desktopQuery, motion: motionQuery }, (context) => {
        const { desktop, motion } = context.conditions as { desktop: boolean; motion: boolean };
        // Tells browser checks (scripts/browser.ts) that motion has started, or chose not to.
        root.dataset.motion = motion ? "on" : "reduced";
        return motion ? choreograph(root, desktop, context, remember) : undefined;
      }, root);
    });
    return () => {
      live = false;
      window.removeEventListener("scroll", scrolled);
      window.removeEventListener("resize", resized);
      conditions.forEach((query) => query.removeEventListener("change", hold));
      ScrollTrigger.removeEventListener("refresh", restore);
      window.clearTimeout(release);
      media?.revert();
      delete root.dataset.motion;
    };
  });
  return null;
}
