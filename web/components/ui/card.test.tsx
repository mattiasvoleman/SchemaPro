import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card";

describe("Card", () => {
  it("renders a fully composed card with all sections' content", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Autumn term</CardTitle>
          <CardDescription>Weeks 34-51</CardDescription>
        </CardHeader>
        <CardContent>412 lessons scheduled</CardContent>
        <CardFooter>Last solved 2 hours ago</CardFooter>
      </Card>,
    );

    expect(screen.getByText("Autumn term")).toBeInTheDocument();
    expect(screen.getByText("Weeks 34-51")).toBeInTheDocument();
    expect(screen.getByText("412 lessons scheduled")).toBeInTheDocument();
    expect(screen.getByText("Last solved 2 hours ago")).toBeInTheDocument();
  });

  it("merges custom classes on the root", () => {
    render(<Card className="border-destructive">Alert card</Card>);
    const card = screen.getByText("Alert card");
    expect(card).toHaveClass("border-destructive", "rounded-lg", "bg-card");
  });
});
