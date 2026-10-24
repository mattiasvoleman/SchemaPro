import { render, renderHook, screen } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Profile, School } from "@/lib/types";
import { ProfileProvider, useProfile } from "./profile-context";

const profile: Profile = {
  id: "u-1",
  authId: "auth-1",
  schoolId: "school-1",
  role: "TEACHER",
  firstName: "Alma",
  lastName: "Berg",
  email: "alma.berg@example.com",
  studentGroupId: null,
};

const school: School = {
  id: "school-1",
  name: "Norra Real",
  slug: "norra-real",
  timezone: "Europe/Stockholm",
};

/**
 * React 19 no longer rethrows render errors from `render()`, so the
 * out-of-provider contract is observed through an error boundary that
 * surfaces the thrown message as text.
 */
class Boundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state: { message: string | null } = { message: null };

  static getDerivedStateFromError(error: Error) {
    return { message: error.message };
  }

  render() {
    return this.state.message ? <p>{this.state.message}</p> : this.props.children;
  }
}

describe("useProfile", () => {
  it("returns the exact profile and school objects given to the provider", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ProfileProvider profile={profile} school={school}>
        {children}
      </ProfileProvider>
    );
    const { result } = renderHook(() => useProfile(), { wrapper });

    // Reference equality: the provider must hand consumers the same objects
    // the server layout resolved, not copies.
    expect(result.current.profile).toBe(profile);
    expect(result.current.school).toBe(school);
  });

  it("passes a null school through unchanged", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ProfileProvider profile={profile} school={null}>
        {children}
      </ProfileProvider>
    );
    const { result } = renderHook(() => useProfile(), { wrapper });

    expect(result.current.school).toBeNull();
    expect(result.current.profile).toBe(profile);
  });

  it("feeds a rendering consumer the provided values", () => {
    function WhoAmI() {
      const { profile: me, school: where } = useProfile();
      return (
        <p>
          {me.firstName} {me.lastName} ({me.role}) at {where?.name}
        </p>
      );
    }

    render(
      <ProfileProvider profile={profile} school={school}>
        <WhoAmI />
      </ProfileProvider>,
    );

    expect(screen.getByText("Alma Berg (TEACHER) at Norra Real")).toBeInTheDocument();
  });

  it("throws a descriptive error when used outside the provider", () => {
    function Orphan() {
      useProfile();
      return <p>should never render</p>;
    }

    // React logs the caught error; keep the test output clean.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(
        <Boundary>
          <Orphan />
        </Boundary>,
      );

      expect(
        screen.getByText("useProfile must be used inside ProfileProvider."),
      ).toBeInTheDocument();
      expect(screen.queryByText("should never render")).not.toBeInTheDocument();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

/*
 * Flera skolor per inloggning: a tab rendered for one school, after another
 * tab switched the browser to another school, reloads when it is looked at
 * again; until then its clients go on naming its own school.
 */
/** The school object, by a name the block below does not shadow. */
const school_ = school;

describe("a tab left on a school another tab switched away from", () => {
  const A = "33333333-3333-4333-8333-333333333333";
  const B = "44444444-4444-4444-8444-444444444444";
  const C = "55555555-5555-4555-8555-555555555555";
  const school = (id: string, closed: string | null = null) => ({
    schoolId: id,
    schoolName: id,
    role: "TEACHER" as const,
    adminProfile: null,
    closed,
    current: id === A,
  });
  const both = [school(A), school(B)];

  const look = (state: "visible" | "hidden") => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    document.dispatchEvent(new Event("visibilitychange"));
  };

  const withReload = () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...original, reload } });
    return {
      reload,
      restore: () => {
        Object.defineProperty(window, "location", { configurable: true, value: original });
        document.cookie = "rastra_school=; max-age=0; path=/";
      },
    };
  };
  const cookie = () => document.cookie.split("; ").find((part) => part.startsWith("rastra_school="))?.slice(14) ?? null;

  it("reloads into the browser's school when it is looked at again, and not while hidden", () => {
    const { reload, restore } = withReload();
    document.cookie = `rastra_school=${B}; path=/`;
    try {
      render(<ProfileProvider profile={profile} school={school_} schools={both} namedSchool={A}><p>sida</p></ProfileProvider>);
      look("hidden");
      expect(reload).not.toHaveBeenCalled();
      look("visible");
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("stays when the browser still names the tab's school, or when the page names none", () => {
    const { reload, restore } = withReload();
    document.cookie = `rastra_school=${A}; path=/`;
    try {
      const { unmount } = render(<ProfileProvider profile={profile} school={school_} schools={both} namedSchool={A}><p>sida</p></ProfileProvider>);
      look("visible");
      unmount();
      document.cookie = `rastra_school=${B}; path=/`;
      render(<ProfileProvider profile={profile} school={school_} schools={both}><p>sida</p></ProfileProvider>);
      look("visible");
      expect(reload).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("replaces a choice this login cannot follow with the page's school, and reloads for none", () => {
    const { reload, restore } = withReload();
    // B is closed to this sign-in: the page fell back to A.
    document.cookie = `rastra_school=${B}; path=/`;
    try {
      render(<ProfileProvider profile={profile} school={school_} schools={[school(A), school(B, "sso_required")]} namedSchool={A}><p>sida</p></ProfileProvider>);
      expect(cookie()).toBe(A);
      look("visible");
      expect(reload).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("drops another person's choice for a login with one school", () => {
    const { restore } = withReload();
    document.cookie = `rastra_school=${C}; path=/`;
    try {
      render(<ProfileProvider profile={profile} school={school_} schools={[school(A)]}><p>sida</p></ProfileProvider>);
      expect(cookie()).toBeNull();
    } finally {
      restore();
    }
  });

  it("leaves the choice alone when the list of schools could not be read", () => {
    const { restore } = withReload();
    document.cookie = `rastra_school=${B}; path=/`;
    try {
      render(<ProfileProvider profile={profile} school={school_} schools={[]} namedSchool={B}><p>sida</p></ProfileProvider>);
      expect(cookie()).toBe(B);
    } finally {
      restore();
    }
  });

  it("hands the login's schools and the page's school to the page", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ProfileProvider profile={profile} school={school_} schools={both} namedSchool={A}>
        {children}
      </ProfileProvider>
    );
    const { result } = renderHook(() => useProfile(), { wrapper });
    expect(result.current.schools).toBe(both);
    expect(result.current.namedSchool).toBe(A);
  });
});
