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
      if (event.key !== "Escape" || !details?.open || event.defaultPrevented) return;
      event.preventDefault();
      details.open = false;
      details.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  return <details ref={ref} className={className} name="portal-menu"><summary>{label}</summary>{children}</details>;
}
