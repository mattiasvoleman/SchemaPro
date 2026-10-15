"use client";

/*
 * Share links for Schemavisaren: one class's, one teacher's or one room's
 * week, or an index of the year's classes and groups or of the school's
 * rooms. A link is an unguessable address (32 random bytes); the gateway keeps
 * only its hash, so the address is shown ONCE, here, right after it is made —
 * copy it then. Revoking stops it within a minute (the viewer's cache is a
 * minute long), and the page says that rather than "at once".
 *
 * A teacher link names its teacher and takes no label of its own: what the
 * page calls the teacher is the school's display choice, and a list of every
 * teacher is not published. Hidden teachers are not offered.
 */

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy, Link2Off } from "lucide-react";
import type { MessageLookup } from "@/lib/engine-message";
import { publicationErrorText } from "@/lib/publication-messages";
import type { PublicationSettings, PublicLink, PublicScopeKind } from "@/lib/publication-types";
import { embedSnippet, formatInstant, publicViewerEmbedUrl, publicViewerUrl } from "@/lib/publication-view";
import { Textarea } from "@/components/ui/textarea";
import { LINK_STATE_VARIANT, type LinkState } from "@/lib/status-variants";
import type { AcademicYear, Person, Room, StudentGroup } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { RowActions } from "@/components/ui/row-actions";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCreatePublicLink, usePublicLinks, useRevokePublicLink } from "./use-public-links";

const KINDS: PublicScopeKind[] = ["GROUP", "TEACHER", "ROOM"];
/** A Select cannot hold an empty value; this stands for "an index". */
const INDEX = "index";

/** The inner-table cells: compact rows, the outer columns flush with the card's padding. */
const TH = "h-auto py-1.5 pr-3 text-xs";
const TD = "py-1.5 pr-3";

interface LinksCardProps {
  year: AcademicYear;
  settings: PublicationSettings;
  groups: readonly StudentGroup[];
  teachers: readonly Person[];
  rooms: readonly Room[];
  hidden: ReadonlySet<string>;
}

export function LinksCard({ year, settings, groups, teachers, rooms, hidden }: LinksCardProps) {
  const t = useTranslations("publishing");
  const locale = useLocale();
  const tErrors = useTranslations("publishing.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const links = usePublicLinks(year.id);
  const create = useCreatePublicLink();
  const revoke = useRevokePublicLink();
  const [kind, setKind] = useState<PublicScopeKind>("GROUP");
  const [target, setTarget] = useState<string>(INDEX);
  const [label, setLabel] = useState("");
  const [made, setMade] = useState<string | null>(null);
  /** The new link's embed code, when the school lets its kind be embedded. */
  const [madeEmbed, setMadeEmbed] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<PublicLink | null>(null);

  const yearGroups = useMemo(() => groups.filter((group) => group.academicYearId === year.id), [groups, year.id]);
  const shownTeachers = useMemo(
    () => teachers.filter((teacher) => teacher.isActive && !hidden.has(teacher.id)),
    [teachers, hidden],
  );
  const targetName = (link: PublicLink): string => {
    if (link.targetId === null) return t("linkIndex");
    if (link.kind === "GROUP") return yearGroups.find((group) => group.id === link.targetId)?.name ?? "?";
    if (link.kind === "ROOM") return rooms.find((room) => room.id === link.targetId)?.name ?? "?";
    const teacher = teachers.find((person) => person.id === link.targetId);
    return teacher ? `${teacher.firstName} ${teacher.lastName}` : "?";
  };
  /** What a row's buttons and its revoke question call the link: its target, or which register. */
  const linkName = (link: PublicLink): string =>
    link.targetId === null ? t(`linkIndexOf.${link.kind}`) : targetName(link);
  const stateOf = (link: PublicLink): LinkState =>
    link.revokedAt ? "REVOKED" : link.notShownBecause ? "NOT_SHOWN" : "ACTIVE";
  const options =
    kind === "GROUP"
      ? yearGroups.map((group) => ({ id: group.id, name: group.name }))
      : kind === "ROOM"
        ? rooms.map((room) => ({ id: room.id, name: room.name }))
        : shownTeachers.map((teacher) => ({ id: teacher.id, name: `${teacher.firstName} ${teacher.lastName}` }));
  const scopeOn =
    settings.publicViewerEnabled &&
    (kind === "GROUP" ? settings.publicGroups : kind === "ROOM" ? settings.publicRooms : settings.publicTeachers);
  const needsTarget = kind === "TEACHER";

  const pickKind = (next: PublicScopeKind) => {
    setKind(next);
    setTarget(INDEX);
    if (next === "TEACHER") setLabel("");
  };

  const doCreate = async () => {
    setProblem(null);
    setMade(null);
    setMadeEmbed(null);
    try {
      const { token, link } = await create.mutateAsync({
        academicYearId: year.id,
        kind,
        ...(target !== INDEX ? { targetId: target } : {}),
        ...(kind !== "TEACHER" && label.trim() ? { label: label.trim() } : {}),
      });
      setMade(publicViewerUrl(window.location.origin, token));
      setMadeEmbed(
        link.embeddable
          ? embedSnippet(
              publicViewerEmbedUrl(window.location.origin, token),
              t("embedFrameTitleOf", { name: link.targetId === null ? t(`linkIndexOf.${link.kind}`) : targetName(link) }),
            )
          : null,
      );
      setLabel("");
    } catch (error) {
      setProblem(publicationErrorText(tErrors, error, tCommon("error")));
    }
  };

  const copy = async (value: string | null, done: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success(done);
    } catch {
      // The address is on screen, selectable; a refused clipboard costs nothing.
    }
  };

  const doRevoke = async () => {
    if (!revoking) return;
    try {
      await revoke.mutateAsync(revoking.id);
      toast.success(t("linkRevoked"));
    } catch (error) {
      toast.error(publicationErrorText(tErrors, error, tCommon("error")));
    } finally {
      setRevoking(null);
    }
  };

  return (
    <SectionCard
      id="publish-links"
      title={t("linksTitle", { year: year.name })}
      description={t("linksBody")}
      descriptionClassName="max-w-prose"
    >
      <div className="grid gap-4 sm:grid-cols-3 [&>*]:min-w-0">
        <FormField id="link-kind" label={t("linkKind")}>
          {(control) => (
            <Select value={kind} onValueChange={(next) => pickKind(next as PublicScopeKind)}>
              <SelectTrigger {...control}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    {t(`linkKinds.${entry}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
        <FormField id="link-target" label={t("linkTarget")}>
          {(control) => (
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger {...control}>
                <SelectValue placeholder={t("linkPickTeacher")} />
              </SelectTrigger>
              <SelectContent>
                {needsTarget ? null : <SelectItem value={INDEX}>{t(`linkIndexOf.${kind}`)}</SelectItem>}
                {options.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
        <FormField id="link-label" label={t("linkLabel")} optional>
          <Input
            value={label}
            maxLength={80}
            disabled={kind === "TEACHER"}
            onChange={(event) => setLabel(event.target.value)}
          />
        </FormField>
      </div>
      {!scopeOn ? <p className="max-w-prose text-sm text-muted-foreground">{t("linkScopeOff")}</p> : null}
      <Button onClick={doCreate} disabled={create.isPending || (needsTarget && target === INDEX)}>
        {t("linkCreate")}
      </Button>
      {made ? (
        <Notice tone="success" title={t("linkMade")}>
          <div className="flex items-center gap-2">
            <Input readOnly value={made} aria-label={t("linkAddress")} onFocus={(event) => event.target.select()} />
            <Button
              variant="outline"
              size="icon"
              onClick={() => void copy(made, t("linkCopied"))}
              title={t("linkCopy")}
              aria-label={t("linkCopy")}
            >
              <Copy />
            </Button>
          </div>
          {madeEmbed ? (
            <div className="mt-3 space-y-1">
              <p className="text-sm">{t("linkEmbedCode")}</p>
              <div className="flex items-start gap-2">
                <Textarea
                  readOnly
                  rows={3}
                  value={madeEmbed}
                  aria-label={t("embedCode")}
                  onFocus={(event) => event.target.select()}
                  className="font-mono text-xs"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => void copy(madeEmbed, t("embedCopied"))}
                  title={t("embedCopy")}
                  aria-label={t("embedCopy")}
                >
                  <Copy />
                </Button>
              </div>
            </div>
          ) : null}
        </Notice>
      ) : null}
      {problem ? <Notice tone="destructive">{problem}</Notice> : null}

      {links.isError && links.data ? (
        // A failed refetch keeps the list as last read, with this above it.
        <LoadError variant="inline" title={t("linksLoadFailed")} hint={tCommon("refetchFailedHint")} />
      ) : null}
      {links.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-16 w-full" />
        </div>
      ) : links.isError && !links.data ? (
        <LoadError variant="inline" title={t("linksLoadFailed")} hint={t("linksLoadFailedHint")} />
      ) : links.data && links.data.length > 0 ? (
        /*
          Inside the card, so no frame of its own. On a phone a row is read by
          which link it is, its status and its button; the kind moves under the
          name (two "Register" rows are a class register and a room register),
          and the label and the last visit step aside.
        */
        <div className="overflow-x-auto">
          <Table>
            <caption className="sr-only">{t("linksTitle", { year: year.name })}</caption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col" className={cn(TH, "hidden pl-0 sm:table-cell")}>
                  {t("linkKind")}
                </TableHead>
                <TableHead scope="col" className={cn(TH, "pl-0 sm:pl-3")}>
                  {t("linkTarget")}
                </TableHead>
                <TableHead scope="col" className={cn(TH, "hidden sm:table-cell")}>
                  {t("linkLabel")}
                </TableHead>
                <TableHead scope="col" className={cn(TH, "hidden sm:table-cell")}>
                  {t("linkLastUsed")}
                </TableHead>
                <TableHead scope="col" className={TH}>
                  {t("validityStatus")}
                </TableHead>
                <TableHead scope="col" className={cn(TH, "w-16 pr-0")}>
                  <span className="sr-only">{tCommon("actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {links.data.map((link) => (
                <TableRow key={link.id}>
                  <TableCell className={cn(TD, "hidden pl-0 font-medium sm:table-cell")}>
                    {t(`linkKinds.${link.kind}`)}
                  </TableCell>
                  <TableCell className={cn(TD, "pl-0 sm:pl-3")}>
                    {targetName(link)}{" "}
                    <span className="block text-xs text-muted-foreground sm:hidden">
                      {t(`linkKinds.${link.kind}`)}
                    </span>
                  </TableCell>
                  <TableCell className={cn(TD, "hidden sm:table-cell")}>
                    {link.label ?? <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className={cn(TD, "hidden whitespace-nowrap tabular-nums sm:table-cell")}>
                    {link.lastUsedAt ? (
                      formatInstant(link.lastUsedAt, locale)
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className={TD}>
                    <Badge variant={LINK_STATE_VARIANT[stateOf(link)]}>
                      {link.revokedAt
                        ? t("linkStateRevoked")
                        : link.notShownBecause
                          ? t(`linkNotShown.${link.notShownBecause}`)
                          : t("linkStateActive")}
                    </Badge>
                    {link.embeddable && !link.notShownBecause ? (
                      <span className="block text-xs text-muted-foreground">{t("linkEmbeddable")}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className={cn(TD, "pr-0 text-right")}>
                    {link.revokedAt ? null : (
                      <RowActions
                        name={linkName(link)}
                        actions={[
                          {
                            label: t("linkRevoke"),
                            icon: Link2Off,
                            ariaLabel: t("linkRevokeNamed", { name: linkName(link) }),
                            onSelect: () => setRevoking(link),
                          },
                        ]}
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : links.data ? (
        <p className="text-sm text-muted-foreground">{t("linksNone")}</p>
      ) : null}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => (open ? null : setRevoking(null))}
        title={revoking ? t("linkRevokeTitle", { name: linkName(revoking) }) : t("linkRevoke")}
        description={t("linkRevokeConfirm")}
        confirmLabel={t("linkRevoke")}
        destructive
        loading={revoke.isPending}
        onConfirm={doRevoke}
      />
    </SectionCard>
  );
}
