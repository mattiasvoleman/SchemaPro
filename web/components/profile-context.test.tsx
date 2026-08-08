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
