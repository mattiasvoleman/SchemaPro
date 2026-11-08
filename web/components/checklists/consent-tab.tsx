"use client";

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { ConsentListItem } from "@/lib/checklists";
import { useReadOnly } from "@/components/profile-context";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import type { ChecklistAudience } from "./checklists";
import { ConsentDetailView } from "./consent-detail";
import { ConsentListForm } from "./consent-list-form";
import { ConsentLists, listOpenerId } from "./consent-lists";
import { useChecklistsText } from "./use-checklists-text";

type View = { kind: "lists" } | { kind: "new" } | { kind: "detail"; id: string; title: string };

/**
 * Focus an element that is not a control (a section's heading) as well as one
 * that is. False when it is not on the page.
 */
function focusElement(id: string): boolean {
  const element = document.getElementById(id);
  if (!element) return false;
  if (!element.matches("a, button, input, select, textarea, [tabindex]")) element.tabIndex = -1;
  element.focus();
  return true;
}

/**
 * Samtycken: the consent lists per class, a new list, and one list with where
 * each pupil stands.
 *
 * Three views in turn, on the page and not in a dialog (a list names a whole
 * class and its table is as wide as the page; the dialogs are for the short
 * questions on it). The view that opens takes focus (its heading), and going
 * back hands focus to what opened it, as a closing dialog does. What has just
 * been done is said in a live region that is always on the page.
 */
export function ConsentTab({ audience }: { audience: ChecklistAudience }) {
  const { t } = useChecklistsText();
  const readOnly = useReadOnly();
  const [view, setView] = useState<View>({ kind: "lists" });
  const [announcement, setAnnouncement] = useState("");
  // Where focus goes after the view changed; a new object each time, so that asking twice for one place moves it twice.
  const [focus, setFocus] = useState<{ id: string } | null>(null);

  useEffect(() => {
    if (focus && !focusElement(focus.id)) focusElement("checklists-consent-lists-title");
  }, [focus]);

  const go = (next: View, focusId: string) => {
    setView(next);
    setFocus({ id: focusId });
  };

  if (view.kind === "new") {
    return (
      <>
        <ConsentListForm
          audience={audience}
          onCancel={() => go({ kind: "lists" }, "checklists-new-list-opener")}
          onCreated={(list) => {
            setAnnouncement(t("newList.created", { title: list.title }));
            go({ kind: "detail", id: list.id, title: list.title }, "checklists-consent-detail-title");
          }}
        />
      </>
    );
  }
  if (view.kind === "detail") {
    return (
      <>
        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>
        <ConsentDetailView
          id={view.id}
          title={view.title}
          audience={audience}
          announce={setAnnouncement}
          onBack={() => go({ kind: "lists" }, listOpenerId(view.id))}
        />
      </>
    );
  }
  return (
    <>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <SectionCard
        id="checklists-consent-lists"
        title={t("lists.title")}
        description={t(`lists.description.${audience}`)}
        action={
          readOnly ? undefined : (
            <Button
              id="checklists-new-list-opener"
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setAnnouncement("");
                go({ kind: "new" }, "checklists-new-list-title");
              }}
              data-writes="DRIFT"
            >
              <Plus aria-hidden="true" />
              {t("lists.new")}
            </Button>
          )
        }
      >
        <ConsentLists
          audience={audience}
          onOpen={(list: ConsentListItem) => go({ kind: "detail", id: list.id, title: list.title }, "checklists-consent-detail-title")}
        />
      </SectionCard>
    </>
  );
}
