"use client";

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { useAckSettings } from "@/lib/ack-queries";
import type { AckSent } from "@/lib/ack";
import { useReadOnly } from "@/components/profile-context";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { AckDetailView } from "./ack-detail";
import { AckRequestForm } from "./ack-form";
import { AckList, openerId } from "./ack-list";
import { useAckText } from "./use-ack-text";

type View = { kind: "list" } | { kind: "new" } | { kind: "detail"; id: string; title: string };

/** The names of pupils the notice spells out before it says "and n more". */
const NAMES_SHOWN = 8;

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
 * The staff's side of Kvittens, the same for an administrator
 * (/admin/acknowledgements) and a teacher (/teacher/acknowledgements): the
 * requests, a new request, and one request with who confirmed it.
 *
 * Three views in turn, on the page and not in a dialog: a request names
 * hundreds of pupils and the form lists them all, which a dialog's height
 * cannot hold, and a dialog's code would be one more chunk to fetch. The view
 * that opens takes focus (its heading), and going back hands focus to what
 * opened it, as a closing dialog does. What the sender has just sent is said in
 * a live region that is always on the page, and in a notice above the list.
 *
 * Who may ask, and about whom, is the gateway's say and the database's; here a
 * läsare (Läsbehörighet) is not offered the button, and a school with Kvittens
 * off says so instead (the gateway answers a request then with 409).
 */
export function AckStaff({ audience }: { audience: "admin" | "teacher" }) {
  const { t, number, names } = useAckText();
  const readOnly = useReadOnly();
  const settings = useAckSettings();
  const [view, setView] = useState<View>({ kind: "list" });
  const [sent, setSent] = useState<AckSent | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // Where focus goes after the view changed; a new object each time, so that asking twice for one place moves it twice.
  const [focus, setFocus] = useState<{ id: string } | null>(null);

  useEffect(() => {
    if (focus && !focusElement(focus.id)) focusElement("ack-list-title");
  }, [focus]);

  const off = settings.data?.enabled === false;

  const go = (next: View, focusId: string) => {
    setView(next);
    setFocus({ id: focusId });
  };

  const sentText = (next: AckSent): string => {
    const without = next.withoutGuardianNames;
    return without.length === 0
      ? ""
      : t("list.sentWithout", {
          count: without.length,
          names: names(without, NAMES_SHOWN, (count) => t("form.moreNames", { count: number(count) })),
        });
  };

  const done = (next: AckSent) => {
    setSent(next);
    setAnnouncement(
      [t("list.sentTitle"), t("list.sentBody", { guardians: next.created.guardians, pupils: next.created.pupils }), sentText(next)]
        .filter(Boolean)
        .join(" "),
    );
    go({ kind: "list" }, "ack-list-title");
  };

  const dismissSent = () => {
    setSent(null);
    setAnnouncement("");
    focusElement("ack-list-title");
  };

  if (view.kind === "new") {
    return <AckRequestForm audience={audience} onCancel={() => go({ kind: "list" }, openerId("new"))} onSent={done} />;
  }
  if (view.kind === "detail") {
    return <AckDetailView id={view.id} title={view.title} onBack={() => go({ kind: "list" }, openerId(view.id))} />;
  }

  return (
    <>
      {/* Always on the page, so that a result put into it is announced. */}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <SectionCard
        id="ack-list"
        title={t("list.title")}
        description={t(`list.description.${audience}`)}
        action={
          readOnly || off ? undefined : (
            <Button
              id={openerId("new")}
              type="button"
              size="sm"
              variant="outline"
              disabled={settings.isLoading}
              onClick={() => {
                setSent(null);
                setAnnouncement("");
                go({ kind: "new" }, "ack-form-title");
              }}
              data-writes="DRIFT"
            >
              <Plus aria-hidden="true" />
              {t("list.new")}
            </Button>
          )
        }
      >
        {sent ? (
          <Notice tone="success" role={null} title={t("list.sentTitle")} onDismiss={dismissSent}>
            <p>{t("list.sentBody", { guardians: sent.created.guardians, pupils: sent.created.pupils })}</p>
            {sent.withoutGuardianNames.length > 0 ? <p>{sentText(sent)}</p> : null}
          </Notice>
        ) : null}
        {off ? (
          <Notice tone="neutral" title={t(`list.disabledTitle.${audience}`)}>
            {t(`list.disabled.${audience}`)}
          </Notice>
        ) : null}
        <AckList audience={audience} onOpen={(item) => go({ kind: "detail", id: item.id, title: item.title }, "ack-detail-title")} />
      </SectionCard>
    </>
  );
}
