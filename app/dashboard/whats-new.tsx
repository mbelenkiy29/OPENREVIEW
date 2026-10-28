"use client";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { Dialog, useCloseDialog } from "../ui/dialog";
import { Icon } from "../ui/icons";
import { announcements, currentAnnouncement, type Announcement } from "../../src/announcements";
import { dismissAnnouncement } from "./actions";

// The header's "What's new" button. A new announcement opens by itself once; the first close records it on
// the user (convex/announcements.ts), so it never opens by itself again. The button reopens the latest one.
export function WhatsNew({ dismissed }: { dismissed: string[] }) {
  const unseen = currentAnnouncement(dismissed), shown = unseen ?? announcements[0], saved = useRef(false);
  if (!shown) return null;
  const close = () => { if (unseen && !saved.current) { saved.current = true; void dismissAnnouncement(unseen.id); } };
  return <Dialog trigger={<Icon name="magicWand" />} triggerClassName="header-button" triggerLabel="What's new" title={shown.title} description={shown.summary} size="wide" open={Boolean(unseen)} onClose={close}>
    <Details announcement={shown} autoplay={Boolean(unseen)} />
  </Dialog>;
}

function Details({ announcement: a, autoplay }: { announcement: Announcement; autoplay: boolean }) {
  const close = useCloseDialog(), video = useRef<HTMLVideoElement>(null);
  // Muted autoplay only when it opens by itself and motion is welcome; preload="none" keeps the clip
  // from downloading on every page for people who already saw it.
  useEffect(() => { if (autoplay && !matchMedia("(prefers-reduced-motion: reduce)").matches) video.current?.play().catch(() => {}); }, [autoplay]);
  return <div className="modal-body whats-new">
    <video ref={video} src={a.video} poster={a.poster} preload="none" muted loop playsInline controls aria-label={`${a.title}: a short silent demo`} />
    <ul>{a.points.map((point) => <li key={point}>{point}</li>)}</ul>
    <div className="modal-footer">{a.links.map((link, i) => <Link key={link.href} className={i === 0 ? "button primary" : "button"} href={link.href} onClick={close}>{link.label}</Link>)}</div>
  </div>;
}
