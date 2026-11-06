"use client";

/*
 * Koder och länkar: what opens a schedule in Schemavisaren. A code is a hundred
 * random bits written in four groups of five ("K7QM2-X9DRT-4V8WN-B5C3H"), made
 * to be read off a letter and typed on /v; the link is the same code in an
 * address. It names ONE schedule — a class or group, a teacher, a room or a
 * pupil — or a LIST of a kind (the classes and groups, the teachers, the
 * rooms; never the pupils: a list of pupils would be a register of where they
 * are). The school hands it out, and nobody can guess it.
 *
 * The code is shown ONCE, right after it is made: the gateway keeps only its
 * hash, so copy it then. A lost one is revoked and made again; revoking stops
 * it within a minute (the viewer's cache is a minute long), and the page says
 * that rather than "at once".
 *
 * What a code opens is the school's settings (Vem och hur), and the page says
 * so before the code is made: a kind that is off shows nothing, a list needs
 * the kind to be on Lista. A teacher's code takes no label of its own (what the
 * page calls the teacher is the school's display choice); a pupil's takes the
 * page's title — "Barn 1" — and the page says "Elevens schema" without one.
 * Schedules that are hidden are not offered. A pupil is picked from a class,
 * and a person with a protected identity, or whose guardian has one, is
 * refused by the gateway (PUBLIC_STUDENT_NOT_SHOWABLE) — which this page, that
 * never holds who is protected, only passes on.
 */

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy, Link2Off } from "lucide-react";
import type { MessageLookup } from "@/lib/engine-message";
import { publicationErrorText } from "@/lib/publication-messages";
import type { HiddenTargets, PublicLink, PublicLinkNotShown, PublicScopeKind, PublicationSettings } from "@/lib/publication-types";
import { embedSnippet, formatInstant, publicViewerEmbedUrl, publicViewerUrl } from "@/lib/publication-view";
import { LINK_STATE_VARIANT, type LinkState } from "@/lib/status-variants";
import type { AcademicYear, Person, Room, StudentGroup } from "@/lib/types";
import { modeOfLink, viewerIsOn } from "@/lib/viewer-modes";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { RowActions } from "@/components/ui/row-actions";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useCreatePublicLink, usePublicLinks, useRevokePublicLink } from "./use-public-links";

const KINDS: PublicScopeKind[] = ["GROUP", "TEACHER", "ROOM", "STUDENT"];
/** A select cannot hold an empty option as a choice; this stands for "the list". */
const INDEX = "index";

/** The inner-table cells: compact rows, the outer columns flush with the card's padding. */
const TH = "h-auto py-1.5 pr-3 text-xs";
const TD = "py-1.5 pr-3";

/** This page's own origin, once the browser has one: the address a code is typed at is shown from it. */
function useOrigin(): string {
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  return origin;
}

interface LinksCardProps {
  year: AcademicYear;
  settings: PublicationSettings;
  groups: readonly StudentGroup[];
  teachers: readonly Person[];
  students: readonly Person[];
  rooms: readonly Room[];
  /** Hidden teachers, and the hidden classes, groups, rooms and pupils: not offered. */
  hiddenTeachers: ReadonlySet<string>;
  hidden: HiddenTargets;
}

interface Made {
  code: string;
  address: string;
  embed: string | null;
}

export function LinksCard({ year, settings, groups, teachers, students, rooms, hiddenTeachers, hidden }: LinksCardProps) {
  const t = useTranslations("schemavisaren");
  const locale = useLocale();
  const tErrors = useTranslations("schemavisaren.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const origin = useOrigin();
  const links = usePublicLinks(year.id);
  const create = useCreatePublicLink();
  const revoke = useRevokePublicLink();
  const [kind, setKind] = useState<PublicScopeKind>("GROUP");
  const [target, setTarget] = useState<string>(INDEX);
  const [classId, setClassId] = useState("");
  const [label, setLabel] = useState("");
  const [made, setMade] = useState<Made | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<PublicLink | null>(null);

  const yearGroups = useMemo(() => groups.filter((group) => group.academicYearId === year.id), [groups, year.id]);
  const hiddenGroups = useMemo(() => new Set(hidden.groups), [hidden.groups]);
  const hiddenRooms = useMemo(() => new Set(hidden.rooms), [hidden.rooms]);
  const hiddenStudents = useMemo(() => new Set(hidden.students), [hidden.students]);
  const classes = useMemo(() => yearGroups.filter((group) => group.kind === "CLASS" && !group.halfOfId), [yearGroups]);
  const nameOf = (person: Person) => `${person.firstName} ${person.lastName}`;

  const targetName = (link: PublicLink): string => {
    if (link.targetId === null) return t("linkIndex");
    if (link.kind === "GROUP") return yearGroups.find((group) => group.id === link.targetId)?.name ?? "?";
    if (link.kind === "ROOM") return rooms.find((room) => room.id === link.targetId)?.name ?? "?";
    const person = (link.kind === "TEACHER" ? teachers : students).find((candidate) => candidate.id === link.targetId);
    return person ? nameOf(person) : "?";
  };
  /** What a row's buttons and its revoke question call the link: its target, or which list. */
  const linkName = (link: PublicLink): string =>
    link.targetId === null ? t(`linkIndexOf.${link.kind as "GROUP" | "TEACHER" | "ROOM"}`) : targetName(link);
  const stateOf = (link: PublicLink): LinkState =>
    link.revokedAt ? "REVOKED" : link.notShownBecause ? "NOT_SHOWN" : "ACTIVE";

  const options: { id: string; name: string }[] =
    kind === "GROUP"
      ? yearGroups.filter((group) => !hiddenGroups.has(group.id)).map((group) => ({ id: group.id, name: group.name }))
      : kind === "ROOM"
        ? rooms.filter((room) => !hiddenRooms.has(room.id)).map((room) => ({ id: room.id, name: room.name }))
        : kind === "TEACHER"
          ? teachers
              .filter((teacher) => teacher.isActive && !hiddenTeachers.has(teacher.id))
              .map((teacher) => ({ id: teacher.id, name: nameOf(teacher) }))
          : students
              .filter((student) => student.isActive && student.studentGroupId === classId && !hiddenStudents.has(student.id))
              .map((student) => ({ id: student.id, name: nameOf(student) }));
  const isStudent = kind === "STUDENT";
  const isList = target === INDEX && !isStudent;
  const readyToMake = isStudent ? target !== INDEX && target !== "" : true;

  /** What the school's settings will make of the code about to be made, said before it is. */
  const advice = (): string | null => {
    if (!viewerIsOn(settings)) return t("adviceNoneOn");
    const chosen = kind === "GROUP" && !isList ? yearGroups.find((group) => group.id === target) : undefined;
    const mode = modeOfLink(settings, kind, isList ? null : { groupKind: chosen?.kind ?? null });
    // The name the setting has under Vem och hur: a list of groups is two settings, a group's is its own kind's.
    const named = kind !== "GROUP" ? kind : isList ? "GROUPS" : chosen?.kind === "TEACHING_GROUP" ? "GROUP" : "CLASS";
    const name = t(`adviceKind.${named}`);
    if (mode === "OFF") return t("adviceOff", { kind: name });
    if (kind === "TEACHER" && settings.publicTeacherDisplay === "NONE") return t("adviceTeacherUnnamed");
    if (isList && mode !== "LIST") return t("adviceNeedsList", { kind: name });
    return null;
  };
  const note = advice();

  const pickKind = (next: PublicScopeKind) => {
    setKind(next);
    setTarget(next === "STUDENT" ? "" : INDEX);
    setClassId("");
    if (next === "TEACHER") setLabel("");
  };

  const doCreate = async () => {
    setProblem(null);
    setMade(null);
    try {
      const { token, link } = await create.mutateAsync({
        academicYearId: year.id,
        kind,
        ...(target !== INDEX && target !== "" ? { targetId: target } : {}),
        ...(kind !== "TEACHER" && label.trim() ? { label: label.trim() } : {}),
      });
      setMade({
        code: token,
        address: publicViewerUrl(window.location.origin, token),
        embed: link.embeddable
          ? embedSnippet(
              publicViewerEmbedUrl(window.location.origin, token),
              t("embedFrameTitleOf", { name: link.targetId === null ? t(`linkIndexOf.${link.kind as "GROUP" | "TEACHER" | "ROOM"}`) : targetName(link) }),
            )
          : null,
      });
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
      // The code is on screen, selectable; a refused clipboard costs nothing.
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
      id="viewer-links"
      title={t("linksTitle", { year: year.name })}
      description={t("linksBody")}
      descriptionClassName="max-w-prose"
    >
      {settings.viewerAudience === "STAFF" ? <Notice tone="neutral">{t("linksStaffOnly")}</Notice> : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 [&>*]:min-w-0" data-writes="PUBLICERING">
        <FormField id="link-kind" label={t("linkKind")}>
          <NativeSelect value={kind} onChange={(event) => pickKind(event.target.value as PublicScopeKind)}>
            {KINDS.map((entry) => (
              <option key={entry} value={entry}>
                {t(`linkKinds.${entry}`)}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        {isStudent ? (
          <FormField id="link-class" label={t("linkClass")}>
            <NativeSelect
              value={classId}
              onChange={(event) => {
                setClassId(event.target.value);
                setTarget("");
              }}
            >
              <option value="">{t("linkPickClass")}</option>
              {classes.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </NativeSelect>
          </FormField>
        ) : null}
        <FormField id="link-target" label={t("linkTarget")}>
          <NativeSelect value={target} disabled={isStudent && classId === ""} onChange={(event) => setTarget(event.target.value)}>
            {isStudent ? (
              <option value="">{t("linkPickStudent")}</option>
            ) : (
              <option value={INDEX}>{t(`linkIndexOf.${kind as "GROUP" | "TEACHER" | "ROOM"}`)}</option>
            )}
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField
          id="link-label"
          label={t("linkLabel")}
          optional
          hint={isStudent ? t("linkLabelStudentHint") : kind === "TEACHER" ? t("linkLabelTeacherHint") : undefined}
        >
          <Input value={label} maxLength={80} disabled={kind === "TEACHER"} onChange={(event) => setLabel(event.target.value)} />
        </FormField>
      </div>
      {note ? <p className="max-w-prose text-sm text-muted-foreground">{note}</p> : null}
      {isStudent ? <p className="max-w-prose text-xs text-muted-foreground">{t("linkStudentNote")}</p> : null}
      <Button onClick={doCreate} disabled={create.isPending || !readyToMake} data-writes="PUBLICERING">
        {t("linkCreate")}
      </Button>
      {made ? (
        <Notice tone="success" title={t("linkMade")}>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={made.code}
                aria-label={t("linkCode")}
                onFocus={(event) => event.target.select()}
                className="font-mono text-base tracking-wider"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={() => void copy(made.code, t("linkCodeCopied"))}
                title={t("linkCodeCopy")}
                aria-label={t("linkCodeCopy")}
              >
                <Copy />
              </Button>
            </div>
            <div className="space-y-1">
              <p className="text-sm">{t("linkMadeAddress")}</p>
              <div className="flex items-center gap-2">
                <Input readOnly value={made.address} aria-label={t("linkAddress")} onFocus={(event) => event.target.select()} />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => void copy(made.address, t("linkCopied"))}
                  title={t("linkCopy")}
                  aria-label={t("linkCopy")}
                >
                  <Copy />
                </Button>
              </div>
            </div>
            {made.embed ? (
              <div className="space-y-1">
                <p className="text-sm">{t("linkEmbedCode")}</p>
                <div className="flex items-start gap-2">
                  <Textarea
                    readOnly
                    rows={3}
                    value={made.embed}
                    aria-label={t("embedCode")}
                    onFocus={(event) => event.target.select()}
                    className="font-mono text-xs"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => void copy(made.embed, t("embedCopied"))}
                    title={t("embedCopy")}
                    aria-label={t("embedCopy")}
                  >
                    <Copy />
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </Notice>
      ) : null}
      {problem ? <Notice tone="destructive">{problem}</Notice> : null}
      <p className="max-w-prose text-xs text-muted-foreground">{t("entryNote", { address: `${origin}/v` })}</p>

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
          name (two "Lista" rows are a class list and a room list), and the
          label and the last visit step aside.
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
                  {t("linkStatus")}
                </TableHead>
                <TableHead scope="col" className={cn(TH, "w-16 pr-0")}>
                  <span className="sr-only">{tCommon("actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {links.data.map((link) => (
                <TableRow key={link.id}>
                  <TableCell className={cn(TD, "hidden pl-0 font-medium sm:table-cell")}>{t(`linkKinds.${link.kind}`)}</TableCell>
                  <TableCell className={cn(TD, "pl-0 sm:pl-3")}>
                    {targetName(link)}{" "}
                    <span className="block text-xs text-muted-foreground sm:hidden">{t(`linkKinds.${link.kind}`)}</span>
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
                          ? t(`linkNotShown.${link.notShownBecause as PublicLinkNotShown}`)
                          : t("linkStateActive")}
                    </Badge>
                    {link.embeddable && !link.notShownBecause ? (
                      <span className="block text-xs text-muted-foreground">{t("linkEmbeddable")}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className={cn(TD, "pr-0 text-right")}>
                    {link.revokedAt ? null : (
                      // RowActions takes no attributes of its own; its one action writes.
                      <span data-writes="PUBLICERING" className="contents">
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
                      </span>
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
