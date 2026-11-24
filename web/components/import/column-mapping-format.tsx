"use client";

import { useTranslations } from "next-intl";
import type { TemplateKind } from "@/lib/column-fields";
import { unfillableFields, type FormatFit, type FormatReading } from "@/lib/skola24-format";
import type { FormatDescriptor } from "@/lib/skola24-format-types";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";

/**
 * Filer från Skola24 in the column panel (Formatbeskrivare, X3): the choice of which Skola24 file a table is, and what the
 * description of it says of the file. Two pieces of the one panel (components/import/column-mapping-panel.tsx), kept apart so that
 * the panel stays what it was: the choice goes with the columns, the notices go with the template's.
 */

/** The select's value for "not chosen": the panel decides, and applies a format only on exact documented headers. */
const AUTO = "";
/** The select's value for "none of these": no description is applied, whatever the table looks like. */
export const NO_FORMAT = "none";

export type HeaderMode = "auto" | "present" | "absent";

/** A description in use, and what reading the table by it made. */
export interface FormatView {
  descriptor: FormatDescriptor;
  reading: FormatReading;
}

export function FormatSelect({
  formats,
  choice,
  headerMode,
  inUse,
  onChoose,
  onHeaderMode,
}: {
  formats: readonly FormatDescriptor[];
  /** A description's id, "none" for "none of these", or null when the user has not chosen. */
  choice: string | null;
  headerMode: HeaderMode;
  inUse: FormatView | null;
  onChoose: (choice: string | null) => void;
  onHeaderMode: (mode: HeaderMode) => void;
}) {
  const t = useTranslations("columnMapping");
  if (formats.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label htmlFor="mapping-format">{t("format.label")}</Label>
        <NativeSelect id="mapping-format" value={choice === null ? AUTO : choice} onChange={(event) => onChoose(event.target.value === AUTO ? null : event.target.value)} className="max-w-md">
          <option value={AUTO}>{t("format.auto")}</option>
          <option value={NO_FORMAT}>{t("format.none")}</option>
          {formats.map((format) => (
            <option key={format.id} value={format.id}>
              {t(`format.names.${format.id}`)}
            </option>
          ))}
        </NativeSelect>
      </div>
      {/* Only a description with one fixed order can read a file that has no header row: the others are read on their headers. */}
      {inUse !== null && inUse.descriptor.order !== null ? (
        <div className="space-y-1">
          <Label htmlFor="mapping-format-header">{t("format.header.label")}</Label>
          <NativeSelect id="mapping-format-header" value={headerMode} onChange={(event) => onHeaderMode(event.target.value as HeaderMode)} className="max-w-md">
            <option value="auto">{t("format.header.auto")}</option>
            <option value="present">{t("format.header.present")}</option>
            <option value="absent">{t("format.header.absent")}</option>
          </NativeSelect>
        </div>
      ) : null}
    </div>
  );
}

/**
 * What the description says: which file the table was read as, from what page, which columns it has that the file lacks, and which
 * fields of Rastra's import it can never give. Without a description in use, the ones the table may be (offered, never applied).
 */
export function FormatNotices({
  kind,
  inUse,
  chosen,
  offered,
  formats,
  placed,
  onUse,
}: {
  kind: TemplateKind;
  inUse: FormatView | null;
  /**
   * The user chose the description in use, in the select or with "Läs den så" on an offer: it is read as they said, and the sentence says
   * that. False when the panel applied it by itself, on the exact documented headers, which is what "känns igen" is.
   */
  chosen: boolean;
  offered: readonly FormatFit[];
  formats: readonly FormatDescriptor[];
  /** The fields a column is placed on now: a field the user has given a column is no longer a gap. */
  placed: ReadonlySet<string>;
  onUse: (id: string) => void;
}) {
  const t = useTranslations("columnMapping");
  if (inUse === null) {
    return (
      <>
        {offered.map((fit) =>
          formats.some((format) => format.id === fit.format) ? (
            <Notice key={fit.format} tone="neutral">
              <span>{t("format.offered", { name: t(`format.names.${fit.format}`) })}</span>{" "}
              <Button size="sm" variant="outline" onClick={() => onUse(fit.format)}>
                {t("format.use")}
              </Button>
            </Notice>
          ) : null,
        )}
      </>
    );
  }
  const { descriptor, reading } = inUse;
  // The page that lists the columns: where the order, and so the whole description, comes from.
  const page = descriptor.columns![0]!.label.source;
  const gaps = unfillableFields(descriptor).filter((id) => !placed.has(id));
  return (
    <div className="space-y-2">
      <Notice tone="success">
        {t(chosen ? "format.read" : "format.recognised", { name: t(`format.names.${descriptor.id}`) })}
        {reading.by === "position" ? ` ${t("format.byPosition")}` : ""}
      </Notice>
      <Notice tone="neutral">
        <span>{t("format.source", { date: page.updated ?? "" })}</span>{" "}
        <a className="underline" href={page.url} target="_blank" rel="noreferrer">
          {t("format.sourceLink")}
        </a>
      </Notice>
      {reading.missing.length > 0 ? <Notice tone="neutral">{t("format.missing", { count: reading.missing.length, names: reading.missing.map((column) => column.label.value).join(", ") })}</Notice> : null}
      {gaps.length > 0 ? <Notice tone="warning">{t("format.gap", { count: gaps.length, names: gaps.map((id) => t(`fields.${kind}.${id}`)).join(", ") })}</Notice> : null}
    </div>
  );
}
