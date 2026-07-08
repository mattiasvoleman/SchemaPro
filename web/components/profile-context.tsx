"use client";

import { createContext, useContext } from "react";
import type { Profile, School } from "@/lib/types";

interface ProfileContextValue {
  profile: Profile;
  school: School | null;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

export function ProfileProvider({
  profile,
  school,
  children,
}: ProfileContextValue & { children: React.ReactNode }) {
  return (
    <ProfileContext.Provider value={{ profile, school }}>{children}</ProfileContext.Provider>
  );
}

export function useProfile(): ProfileContextValue {
  const value = useContext(ProfileContext);
  if (!value) {
    throw new Error("useProfile must be used inside ProfileProvider.");
  }
  return value;
}
