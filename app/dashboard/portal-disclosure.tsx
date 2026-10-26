"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";

export function PortalDisclosure({ className, label, children }: {
  className: string; label: ReactNode; children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null), pathname = usePathname();
  // The app chrome stays mounted across navigations, so close the menu when the page changes.
  useEffect(() => { if (ref.current) ref.current.open = false; }, [pathname]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const details = ref.current;
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) details.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      const details = ref.current;
      // Escape inside a dialog opened from the menu closes that dialog first.
      if (event.key !== "Escape" || !details?.open || event.defaultPrevented || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      details.open = false;
      details.querySelector("summary")?.focus();
    };
    // A chosen item closes the menu once its own action (link, form, dialog) has started; links that
    // only change the query string leave the pathname, and so the effect above, untouched.
    const pick = (event: MouseEvent) => {
      const details = ref.current;
      if (details?.open && event.target instanceof Element && details.contains(event.target) && event.target.closest(".menu-item")) setTimeout(() => { details.open = false; });
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    document.addEventListener("click", pick);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("click", pick);
    };
  }, []);
  return <details ref={ref} className={className} name="portal-menu"><summary>{label}</summary>{children}</details>;
}
