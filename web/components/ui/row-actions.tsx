"use client";

import { useRef } from "react";
import { useTranslations } from "next-intl";
import { MoreHorizontal, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface RowAction {
  /** The verb alone ("Redigera", "Ta bort"): the menu item's text and the start of the button's name. */
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  /** The whole accessible name, when "{label} {name}" does not read as a sentence. */
  ariaLabel?: string;
  disabled?: boolean;
}

export interface RowActionsProps {
  /** The row's own name ("7A", "Alma Berg"), so every button says which row it acts on. */
  name: string;
  /**
   * In reading order. Up to `inlineMax` are icon buttons; past that, the first
   * inlineMax − 1 stay and the rest go in a menu.
   */
  actions: RowAction[];
  /**
   * How many icon buttons the row shows before it folds the rest into a menu;
   * 3 unless the page needs more in sight. Raise it where the manual sends the
   * reader to an icon on the row (Personer's envelope): an icon the manual
   * names must not hide behind "Fler åtgärder".
   */
  inlineMax?: number;
  className?: string;
}

/** The most icon buttons a row shows before it folds the rest into a menu, unless the page says otherwise. */
export const ROW_ACTIONS_INLINE_MAX = 3;

/**
 * A table row's actions: ghost icon buttons named after the row ("Redigera
 * 7A", "Ta bort 7A"), never a generic "Redigera" a screen reader cannot place.
 * The same name is each button's title, so a mouse user reads on hover what
 * the icon does. Put it in the last TableCell with className="text-right",
 * sized to its buttons (w-24 for two, w-32 for three, w-40 for four). The
 * delete icon is not painted red: the ConfirmDialog it opens carries the red.
 *
 * DropdownMenu is already in the shell's chunk (the locale switcher), so the
 * overflow menu adds no bytes to a route.
 */
export function RowActions({
  name,
  actions,
  inlineMax = ROW_ACTIONS_INLINE_MAX,
  className,
}: RowActionsProps) {
  const t = useTranslations("common");
  const folds = actions.length > inlineMax;
  const inline = folds ? actions.slice(0, inlineMax - 1) : actions;
  const overflow = folds ? actions.slice(inlineMax - 1) : [];
  const nameOf = (action: RowAction) => action.ariaLabel ?? t("actionNamed", { action: action.label, name });

  /*
   * A menu item's action runs once the menu has CLOSED, not as it is picked —
   * the admin/timetable header's pattern. Run from onSelect, an action that
   * opens a dialog (Ta bort's ConfirmDialog) mounted it while the menu's own
   * focus trap still held, and the menu then let go into a removed item:
   * focus fell to <body>, and a keyboard user who cancelled started over from
   * the top of the page. Run from onCloseAutoFocus, focus is put back on
   * "Fler åtgärder för {name}" first and the action second, so the dialog
   * opens from that button and hands focus back to it when it closes
   * (DialogContent returns focus to what had it when it opened).
   */
  const trigger = useRef<HTMLButtonElement>(null);
  const chosen = useRef<(() => void) | null>(null);

  return (
    <div className={cn("flex items-center justify-end gap-1", className)}>
      {inline.map((action) => (
        <Button
          key={action.label}
          type="button"
          variant="ghost"
          size="icon"
          onClick={action.onSelect}
          disabled={action.disabled}
          aria-label={nameOf(action)}
          title={nameOf(action)}
        >
          <action.icon aria-hidden="true" />
        </Button>
      ))}
      {overflow.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              ref={trigger}
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("moreActionsFor", { name })}
              title={t("moreActionsFor", { name })}
            >
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onCloseAutoFocus={(event) => {
              const action = chosen.current;
              chosen.current = null;
              // Escape or a click away: nothing was chosen, and Radix hands
              // focus back to the trigger (or leaves it where the click put it).
              if (!action) return;
              event.preventDefault();
              trigger.current?.focus();
              action();
            }}
          >
            {overflow.map((action) => (
              <DropdownMenuItem
                key={action.label}
                onSelect={() => {
                  chosen.current = action.onSelect;
                }}
                disabled={action.disabled}
                aria-label={action.ariaLabel}
              >
                <action.icon aria-hidden="true" />
                {action.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
