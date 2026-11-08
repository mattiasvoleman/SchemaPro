"use client";

import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { InstructionTab } from "./instruction-tab";
import { LazyPanel, useLazy } from "./lazy-panel";
import { useChecklistsText } from "./use-checklists-text";

export type ChecklistAudience = "admin" | "teacher";

const TABS = ["instructions", "consents"] as const;
type Tab = (typeof TABS)[number];

/**
 * Checklistor, the same for an administrator (/admin/checklists) and a teacher
 * (/teacher/checklists): the instruction proofs (Instruktionsbevis) and the
 * consent lists per class (Samtycken).
 *
 * Two tabs in an accessible tablist, with the choice kept here and not in the
 * address: a teacher in the middle of ticking a roster who looks at a list comes
 * back to the roster as they left it. A panel is drawn the first time its tab is
 * opened and then kept (hidden while the other is shown), so that a roster is
 * not read again, and recorded again in the läslogg, by a click on a tab, and
 * a list's first read waits until somebody wants it.
 *
 * Who may do what is the gateway's say and the database's: an administrator
 * under Drift writes everything, a teacher ticks the pupils of their own groups
 * and lessons and writes for their mentees. The screens show what the reader
 * is given and offer what the answers allow.
 */
export function Checklists({ audience }: { audience: ChecklistAudience }) {
  const { t } = useChecklistsText();
  const [tab, setTab] = useState<Tab>("instructions");
  const [opened, setOpened] = useState<ReadonlySet<Tab>>(() => new Set<Tab>(["instructions"]));
  const triggers = useRef<Record<Tab, HTMLButtonElement | null>>({ instructions: null, consents: null });
  // The consent lists are fetched when their tab is first opened (lazy-panel.tsx), not with the page.
  const [Consents, againConsents] = useLazy<{ audience: ChecklistAudience }>(() =>
    import("./consent-tab").then((module) => ({ default: module.ConsentTab })),
  );

  const choose = (next: Tab, focus = false) => {
    setTab(next);
    setOpened((current) => (current.has(next) ? current : new Set(current).add(next)));
    if (focus) triggers.current[next]?.focus();
  };

  // Roving tabindex: one stop in the tab order; the arrows, Home and End move and choose (automatic activation).
  const onKeyDown = (event: React.KeyboardEvent) => {
    const index = TABS.indexOf(tab);
    const moves = new Map<string, Tab>([
      ["ArrowRight", TABS[(index + 1) % TABS.length]!],
      ["ArrowLeft", TABS[(index + TABS.length - 1) % TABS.length]!],
      ["Home", TABS[0]],
      ["End", TABS[TABS.length - 1]!],
    ]);
    const target = moves.get(event.key);
    if (!target) return;
    event.preventDefault();
    choose(target, true);
  };

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label={t("tabs.label")}
        onKeyDown={onKeyDown}
        className="inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground"
      >
        {TABS.map((one) => (
          <button
            key={one}
            ref={(element) => {
              triggers.current[one] = element;
            }}
            type="button"
            role="tab"
            id={`checklists-tab-${one}`}
            aria-selected={tab === one}
            aria-controls={`checklists-panel-${one}`}
            tabIndex={tab === one ? 0 : -1}
            onClick={() => choose(one)}
            className={cn(
              "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              tab === one && "bg-background text-foreground shadow",
            )}
          >
            {t(`tabs.${one}`)}
          </button>
        ))}
      </div>
      {TABS.filter((one) => opened.has(one)).map((one) => (
        <div
          key={one}
          role="tabpanel"
          id={`checklists-panel-${one}`}
          aria-labelledby={`checklists-tab-${one}`}
          hidden={tab !== one}
          className="space-y-4"
        >
          {one === "instructions" ? (
            <InstructionTab audience={audience} />
          ) : (
            <LazyPanel again={againConsents} height="h-48">
              <Consents audience={audience} />
            </LazyPanel>
          )}
        </div>
      ))}
    </div>
  );
}
