"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

/*
 * Att lägga: the lessons still to lay, one brick each, grouped by post. A brick
 * is pressed to choose it (Enter or Space on the keyboard, a tap on a phone) and,
 * with a mouse or a pen, pulled into the week. What happens to it is the page's;
 * this only draws and says what was pressed.
 */

export interface BrickItem {
  /** `post|teacher|minutes#n` (placement-rows.ts): unique while the post has the lesson to lay. */
  key: string;
  /** "A. Ek · 60 min". */
  text: string;
  color: string;
}

export interface BrickGroup {
  postId: string;
  /** "Matematik 7A". */
  title: string;
  bricks: BrickItem[];
}

export interface BrickListProps {
  groups: readonly BrickGroup[];
  selected: string | null;
  onSelect: (key: string) => void;
  /** A mouse or a pen went down on a brick: the page hands it to the grid as a drag. */
  onPull: (key: string, event: React.PointerEvent) => void;
}

export function BrickList({ groups, selected, onSelect, onPull }: BrickListProps) {
  const t = useTranslations("placementWeek");
  if (groups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="bricks-empty">
        {t("nothingToLay")}
      </p>
    );
  }
  return (
    <ul className="space-y-2" aria-label={t("toLayTitle")}>
      {groups.map((group) => (
        <li key={group.postId} data-testid="brick-post">
          <p className="mb-1 break-words text-xs font-semibold">{group.title}</p>
          <div className="flex flex-wrap gap-1.5">
            {group.bricks.map((brick) => (
              <button
                key={brick.key}
                type="button"
                data-brick={brick.key}
                aria-pressed={selected === brick.key}
                onPointerDown={(event) => {
                  // A finger scrolls the list; only a mouse or a pen pulls (a tap chooses).
                  if (event.pointerType === "touch" || event.button !== 0) return;
                  onPull(brick.key, event);
                }}
                onClick={() => onSelect(brick.key)}
                style={{ borderLeftColor: brick.color }}
                className={cn(
                  "max-w-full cursor-grab select-none break-words rounded-md border border-l-4 bg-card px-2 py-1 text-left text-xs shadow-sm",
                  "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected === brick.key && "outline outline-2 outline-offset-1 outline-foreground",
                )}
              >
                {brick.text}
              </button>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}
