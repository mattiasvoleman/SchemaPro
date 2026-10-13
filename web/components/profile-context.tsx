"use client";

import { createContext, useContext } from "react";
import { usePathname } from "@/i18n/navigation";
import type { Profile, School } from "@/lib/types";

interface ProfileContextValue {
  profile: Profile;
  school: School | null;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

/**
 * Roller i skolan: the admin pages a profile does not use, each with the
 * page shown in its place. A style rule the layout writes
 * (components/admin/area-refusal.tsx closedMenuStyle) leaves them out of
 * the menu, and a request for one anyway (a bookmark, a link from
 * elsewhere) gets from ClosedPageGate below a page that says which area it
 * belongs to and leads back to the overview, instead of a page whose every
 * button would answer 403. Nothing is refused here; the gateway and the
 * database refuse the writes.
 *
 * Built by the (app) layout on the server (components/admin/area-refusal.tsx
 * closedPagesFor), so the client only picks one and no route carries the
 * page's code. It lives in the profile context and not in AppShell: the
 * part of the chunk every signed-in route loads that holds AppShell sits at
 * Turbopack's merge threshold (minChunkSize), and any code added there split
 * the chunk in two, at +0.7 KB on every route.
 */
export type ClosedPages = Readonly<Record<string, React.ReactNode>>;

const ClosedContext = createContext<ClosedPages>({});

export function ProfileProvider({
  profile,
  school,
  closed = {},
  children,
}: ProfileContextValue & { closed?: ClosedPages; children: React.ReactNode }) {
  return (
    <ProfileContext.Provider value={{ profile, school }}>
      <ClosedContext.Provider value={closed}>{children}</ClosedContext.Provider>
    </ProfileContext.Provider>
  );
}

export function useProfile(): ProfileContextValue {
  const value = useContext(ProfileContext);
  if (!value) {
    throw new Error("useProfile must be used inside ProfileProvider.");
  }
  return value;
}

/** The page, or in place of a closed one the page that says why. */
export function ClosedPageGate({ children }: { children: React.ReactNode }) {
  const closed = useContext(ClosedContext);
  const pathname = usePathname();
  const path = Object.keys(closed).find((page) => pathname === page || pathname.startsWith(`${page}/`));
  return path ? closed[path] : children;
}
