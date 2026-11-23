import { useSyncExternalStore, type MouseEvent, type ReactNode } from "react";

const event = "turflab:navigate";
const locationPath = () => window.location.pathname;
function subscribe(update: () => void) {
  window.addEventListener("popstate", update);
  window.addEventListener(event, update);
  return () => {
    window.removeEventListener("popstate", update);
    window.removeEventListener(event, update);
  };
}

export const useSportPath = () => useSyncExternalStore(subscribe, locationPath);
export const isBoatPath = (path: string) => /^\/boatrace(?:\/|$)/.test(path);

export function TurfLink({ to, children, ...props }: {
  to: string;
  children: ReactNode;
  className?: string;
  "aria-current"?: "page" | "true";
}) {
  function follow(e: MouseEvent<HTMLAnchorElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    if (window.location.pathname === to) return;
    window.history.pushState(null, "", to);
    window.dispatchEvent(new Event(event));
    window.scrollTo(0, 0);
  }
  return <a href={to} onClick={follow} {...props}>{children}</a>;
}

export function SportSwitch({ boat = false }: { boat?: boolean }) {
  return <nav className="sport-switch" data-sport={boat ? "boat" : "horse"} aria-label="競技切替">
    <TurfLink to="/" aria-current={!boat ? "true" : undefined}>競馬</TurfLink>
    <TurfLink to="/boatrace" aria-current={boat ? "true" : undefined}>競艇</TurfLink>
  </nav>;
}
