import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useTheme } from "next-themes";
import { beforeEach, describe, expect, it } from "vitest";
import { Providers } from "./providers";

// jsdom has no matchMedia; next-themes needs it to resolve the "system"
// theme. The stub reads a mutable flag so each test can pick the OS
// preference it simulates.
const media = { prefersDark: false };

beforeEach(() => {
  media.prefersDark = false;
  window.localStorage.clear();
  document.documentElement.removeAttribute("class");
  document.documentElement.removeAttribute("style");
  window.matchMedia = ((query: string) => ({
    matches: media.prefersDark,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

function ThemeProbe() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <div>
      <span>current:{theme}</span>
      <span>resolved:{resolvedTheme}</span>
      <button onClick={() => setTheme("dark")}>choose dark</button>
    </div>
  );
}

describe("Providers", () => {
  it("renders its children", () => {
    render(
      <Providers>
        <p>login page body</p>
      </Providers>,
    );
    expect(screen.getByText("login page body")).toBeInTheDocument();
  });

  it("defaults to the system theme and resolves a light OS preference onto <html>", async () => {
    render(
      <Providers>
        <ThemeProbe />
      </Providers>,
    );

    await waitFor(() => {
      expect(screen.getByText("current:system")).toBeInTheDocument();
      expect(screen.getByText("resolved:light")).toBeInTheDocument();
    });
    // attribute="class": the resolved theme lands as a class, which is what
    // Tailwind's dark: variants key off.
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("resolves a dark OS preference to the dark class (enableSystem)", async () => {
    media.prefersDark = true;
    render(
      <Providers>
        <ThemeProbe />
      </Providers>,
    );

    await waitFor(() => {
      expect(screen.getByText("resolved:dark")).toBeInTheDocument();
    });
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("setTheme('dark') swaps the class and persists the choice", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <ThemeProbe />
      </Providers>,
    );

    await user.click(screen.getByRole("button", { name: "choose dark" }));

    await waitFor(() => {
      expect(screen.getByText("current:dark")).toBeInTheDocument();
    });
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("light")).toBe(false);
    expect(window.localStorage.getItem("theme")).toBe("dark");
  });

  it("reads a previously persisted theme back on mount", async () => {
    window.localStorage.setItem("theme", "dark");
    render(
      <Providers>
        <ThemeProbe />
      </Providers>,
    );

    await waitFor(() => {
      expect(screen.getByText("current:dark")).toBeInTheDocument();
    });
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
