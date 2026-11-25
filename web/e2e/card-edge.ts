/**
 * What the 320 px gates measure of a card: every element of the card (not the page around it, whose läsår choice runs past the edge at 320 px
 * on pages that are not these) that reaches past the page's left or right edge.
 *
 * Browser-side and self-contained: Playwright writes the function into the page (`page.evaluate(cardsOf, titles)`), so it names nothing from
 * this module. The card is the SECTION its heading is in. `closest("[id]")` was the heading itself: SectionCard gives its heading an id of
 * its own (`<id>-title`), and a measure of the heading alone is one element of a card of thirty and never sees a row or a link that overflows.
 * A unit test (lib/card-edge.test.ts) runs it over the real cards, so that a measure that measures nothing falls there and not only in a
 * browser, where nobody looks at what was measured.
 */
export function cardsOf(titles: string[]): { cards: number; measured: number; beyond: number } {
  const cards = [...document.querySelectorAll("h2, h3")]
    .filter((heading) => titles.includes((heading.textContent ?? "").trim()))
    .map((heading) => heading.closest("section"))
    .filter((card): card is HTMLElement => card !== null);
  const mine = cards.flatMap((card) => [card, ...card.querySelectorAll("*")]).filter((element) => !element.closest(".sr-only"));
  return {
    cards: cards.length,
    measured: mine.length,
    beyond: mine.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && (rect.right > window.innerWidth + 1 || rect.left < -1);
    }).length,
  };
}
