"use client";

import { LazyPanel, useLazy } from "./lazy-panel";
import { TickPanel } from "./tick-panel";
import type { ChecklistAudience } from "./checklists";

/**
 * Instruktionsbevis: the school's templates (the administrator's to make and
 * retire) and "Bocka av", where an administrator or a teacher ticks the pupils
 * of a group who have had an instruction.
 *
 * The templates are fetched when they are drawn, which only an administrator's
 * page does (lazy-panel.tsx): a teacher's page, the tighter bundle budget, never
 * carries them.
 */
export function InstructionTab({ audience }: { audience: ChecklistAudience }) {
  const [Templates, againTemplates] = useLazy<object>(() => import("./templates-card").then((module) => ({ default: module.TemplatesCard })));
  return (
    <>
      {audience === "admin" ? (
        <LazyPanel again={againTemplates}>
          <Templates />
        </LazyPanel>
      ) : null}
      <TickPanel audience={audience} />
    </>
  );
}
