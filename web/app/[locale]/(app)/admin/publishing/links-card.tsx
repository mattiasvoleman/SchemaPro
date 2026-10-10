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
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import type { MessageLookup } from "@/lib/engine-message";
import { publicationErrorText } from "@/lib/publication-messages";
import type { PublicationSettings, PublicLink, PublicScopeKind } from "@/lib/publication-types";
import { publicViewerUrl } from "@/lib/publication-view";
import type { AcademicYear, Person, Room, StudentGroup } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCreatePublicLink, usePublicLinks, useRevokePublicLink } from "./use-public-links";

const KINDS: PublicScopeKind[] = ["GROUP", "TEACHER", "ROOM"];
/** A Select cannot hold an empty value; this stands for "an index". */
const INDEX = "index";

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
  const tErrors = useTranslations("publishing.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const links = usePublicLinks(year.id);
  const create = useCreatePublicLink();
  const revoke = useRevokePublicLink();
  const [kind, setKind] = useState<PublicScopeKind>("GROUP");
  const [target, setTarget] = useState<string>(INDEX);
  const [label, setLabel] = useState("");
  const [made, setMade] = useState<string | null>(null);
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
    try {
      const { token } = await create.mutateAsync({
        academicYearId: year.id,
        kind,
        ...(target !== INDEX ? { targetId: target } : {}),
        ...(kind !== "TEACHER" && label.trim() ? { label: label.trim() } : {}),
      });
      setMade(publicViewerUrl(window.location.origin, token));
      setLabel("");
    } catch (error) {
      setProblem(publicationErrorText(tErrors, error, tCommon("error")));
    }
  };

  const copy = async () => {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made);
      toast.success(t("linkCopied"));
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
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("linksTitle", { year: year.name })}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p>{t("linksBody")}</p>
        <div className="grid gap-3 sm:grid-cols-3 [&>*]:min-w-0">
          <div className="space-y-1">
            <Label htmlFor="link-kind">{t("linkKind")}</Label>
            <Select value={kind} onValueChange={(next) => pickKind(next as PublicScopeKind)}>
              <SelectTrigger id="link-kind" aria-label={t("linkKind")}>
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
          </div>
          <div className="space-y-1">
            <Label htmlFor="link-target">{t("linkTarget")}</Label>
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger id="link-target" aria-label={t("linkTarget")}>
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
          </div>
          <div className="space-y-1">
            <Label htmlFor="link-label">{t("linkLabel")}</Label>
            <Input
              id="link-label"
              value={label}
              maxLength={80}
              disabled={kind === "TEACHER"}
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>
        </div>
        {!scopeOn ? <p>{t("linkScopeOff")}</p> : null}
        <Button onClick={doCreate} disabled={create.isPending || (needsTarget && target === INDEX)}>
          {t("linkCreate")}
        </Button>
        {made ? (
          <div className="space-y-1 rounded-md border p-3" role="status">
            <p className="font-medium">{t("linkMade")}</p>
            <div className="flex items-center gap-2">
              <Input readOnly value={made} aria-label={t("linkAddress")} onFocus={(event) => event.target.select()} />
              <Button variant="outline" size="icon" onClick={copy} title={t("linkCopy")} aria-label={t("linkCopy")}>
                <Copy />
              </Button>
            </div>
          </div>
        ) : null}
        {problem ? (
          <p role="alert" className="font-medium">
            {problem}
          </p>
        ) : null}

        {links.data && links.data.length > 0 ? (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-foreground">{t("linkKind")}</TableHead>
                  <TableHead className="text-foreground">{t("linkTarget")}</TableHead>
                  <TableHead className="text-foreground">{t("linkLabel")}</TableHead>
                  <TableHead className="text-foreground">{t("linkLastUsed")}</TableHead>
                  <TableHead className="text-foreground">{t("validityStatus")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {links.data.map((link) => (
                  <TableRow key={link.id}>
                    <TableCell>{t(`linkKinds.${link.kind}`)}</TableCell>
                    <TableCell>{targetName(link)}</TableCell>
                    <TableCell>{link.label ?? "–"}</TableCell>
                    <TableCell className="tabular-nums">{link.lastUsedAt?.slice(0, 10) ?? "–"}</TableCell>
                    <TableCell>
                      <Badge variant={link.revokedAt || link.notShownBecause ? "outline" : "success"}>
                        {link.revokedAt
                          ? t("linkStateRevoked")
                          : link.notShownBecause
                            ? t(`linkNotShown.${link.notShownBecause}`)
                            : t("linkStateActive")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {link.revokedAt ? null : (
                        <Button variant="outline" size="sm" onClick={() => setRevoking(link)}>
                          {t("linkRevoke")}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : links.data ? (
          <p>{t("linksNone")}</p>
        ) : null}
      </CardContent>
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => (open ? null : setRevoking(null))}
        title={t("linkRevoke")}
        description={t("linkRevokeConfirm")}
        confirmLabel={t("linkRevoke")}
        destructive
        loading={revoke.isPending}
        onConfirm={doRevoke}
      />
    </Card>
  );
}
