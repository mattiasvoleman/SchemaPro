import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DialogLoadBoundary } from "@/components/schedule/dialog-load-boundary";

afterEach(cleanup);

function Broken(): never {
  throw new Error("chunk did not arrive");
}

describe("DialogLoadBoundary", () => {
  it("draws what it holds while nothing throws", () => {
    render(
      <DialogLoadBoundary onError={vi.fn()} fallback={<p>the hint</p>}>
        <p>the part</p>
      </DialogLoadBoundary>,
    );

    expect(screen.getByText("the part")).toBeInTheDocument();
    expect(screen.queryByText("the hint")).toBeNull();
  });

  it("hands what threw to the page and draws nothing where the part was, when it has no fallback", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onError = vi.fn();
    const { container } = render(
      <DialogLoadBoundary onError={onError}>
        <Broken />
      </DialogLoadBoundary>,
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(container).toBeEmptyDOMElement();
  });

  it("draws its fallback where the part was, for a part that answers a question the page has already asked", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onError = vi.fn();
    render(
      <DialogLoadBoundary onError={onError} fallback={<p>the hint</p>}>
        <Broken />
      </DialogLoadBoundary>,
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(screen.getByText("the hint")).toBeInTheDocument();
  });
});
