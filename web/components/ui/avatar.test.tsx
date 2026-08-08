import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Avatar, AvatarFallback } from "./avatar";

describe("Avatar", () => {
  it("renders the fallback initials when there is no image", () => {
    render(
      <Avatar>
        <AvatarFallback>MV</AvatarFallback>
      </Avatar>,
    );

    expect(screen.getByText("MV")).toBeInTheDocument();
  });

  it("merges custom classes on root and fallback", () => {
    render(
      <Avatar className="h-12 w-12">
        <AvatarFallback className="bg-destructive">MV</AvatarFallback>
      </Avatar>,
    );

    const fallback = screen.getByText("MV");
    expect(fallback).toHaveClass("bg-destructive");
    // tailwind-merge lets the custom size replace the default h-9 w-9.
    const root = fallback.parentElement;
    expect(root).toHaveClass("h-12", "w-12", "rounded-full");
    expect(root).not.toHaveClass("h-9");
  });
});
