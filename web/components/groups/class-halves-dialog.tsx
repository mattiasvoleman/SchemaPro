"use client";

// Halvklasser on Klasser: "Dela klassen" and "Placera elever".
//
// A half (StudentGroup.halfOfId) is a teaching group cut out of one class —
// 7A:1 and 7A:2 for slöjd and NO-laborationer. The school splits the class
// here, puts timplansposter on the halves on Timplansposter, and generates
// before anyone is placed: a half's lessons keep its class busy except
// beside the other half's (src/common/class-halves.ts). Pupils are placed
// later, here or by the membership file.
//
// Loaded the first time either dialog opens (lazy-class-halves-dialog.tsx),
// as the CSV import is: a school that never splits a class fetches none of it.

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { StudentGroup } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

/** A pupil the placement lists: an active STUDENT and their home class. */
export interface HalvesPupil {
  id: string;
  firstName: string;
  lastName: string;
  studentGroupId: string | null;
}

export type HalvesOpened = { mode: "split" | "place"; theClass: StudentGroup };

export interface ClassHalvesDialogProps {
  /** Which dialog, for which class; null: closed. A new object for every opening. */
  opened: HalvesOpened | null;
  onClose: () => void;
  groups: readonly StudentGroup[];
  pupils: readonly HalvesPupil[];
  memberships: ReadonlyArray<{ studentId: string; studentGroupId: string }>;
  /**
   * Whether the pupils and the memberships have answered and are not being
   * asked again. A placement is saved as each half's complete list, so one
   * drawn before they answer — or from the answer before the last save —
   * would take placed pupils out of their halves.
   */
  reads: "ready" | "loading" | "failed";
  /**
   * When the older of the two answers arrived (react-query's dataUpdatedAt).
   * The placement is drawn only from answers newer than the opening that
   * asked for them: the page's own reads may be minutes old, and a placement
   * another admin, a file or the sync made since would be saved away.
   */
  readsAt: number;
}

/** The page's reads a placement is drawn from, asked again at every opening and retry. */
const PLACEMENT_READS = [["people"], ["groupMemberships"]];

/** What a split or a placement changes: the groups, the counts, and who sits where. */
const WRITTEN = [["groups"], ["people", "yearRosters"], ["groupMemberships"], ["groupMembers"], ["lessonRoster"]];

export function ClassHalvesDialog(props: ClassHalvesDialogProps) {
  const { opened, onClose, reads, readsAt } = props;
  const queryClient = useQueryClient();
  // The last opening, drawn through the close animation as well.
  const [shown, setShown] = useState(opened);
  if (opened !== null && opened !== shown) setShown(opened);
  // Every opening of a placement asks the reads again, and remembers when.
  const [asked, setAsked] = useState<{ opening: HalvesOpened; at: number } | null>(null);
  const askAgain = () => {
    for (const queryKey of PLACEMENT_READS) void queryClient.refetchQueries({ queryKey, exact: true });
  };
  useEffect(() => {
    if (opened?.mode !== "place") return;
    setAsked({ opening: opened, at: Date.now() });
    for (const queryKey of PLACEMENT_READS) void queryClient.refetchQueries({ queryKey, exact: true });
  }, [opened, queryClient]);
  // The opening whose placement may be drawn: once the reads have answered
  // since it asked them, and from then on for that opening, so a refetch
  // while the school is choosing never redraws over its choices.
  const [settled, setSettled] = useState<HalvesOpened | null>(null);
  const fresh = asked !== null && asked.opening === opened && readsAt >= asked.at;
  if (opened !== null && opened.mode === "place" && settled !== opened && reads === "ready" && fresh) setSettled(opened);
  return (
    <Dialog open={opened !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        {shown?.mode === "split" ? <Split key={shown.theClass.id} theClass={shown.theClass} onClose={onClose} /> : null}
        {shown?.mode === "place" ? (
          settled === shown ? (
            <Place key={shown.theClass.id} {...props} theClass={shown.theClass} />
          ) : (
            <Waiting theClass={shown.theClass} failed={reads === "failed"} onRetry={askAgain} onClose={onClose} />
          )
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** The placement's frame while its reads are out, or after one failed: asked again from here. */
function Waiting({
  theClass,
  failed,
  onRetry,
  onClose,
}: {
  theClass: StudentGroup;
  failed: boolean;
  onRetry: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("groups.halves");
  const tCommon = useTranslations("common");
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{t("placeTitle", { name: theClass.name })}</DialogTitle>
        <DialogDescription>{t("placeBody")}</DialogDescription>
      </DialogHeader>
      <p className={failed ? "text-sm text-destructive" : "text-sm text-muted-foreground"} role={failed ? "alert" : "status"}>
        {failed ? t("placeLoadFailed") : t("placeLoading")}
      </p>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {tCommon("close")}
        </Button>
        {failed ? (
          <Button type="button" onClick={onRetry}>
            {tCommon("retry")}
          </Button>
        ) : null}
      </DialogFooter>
    </div>
  );
}

function useWritten() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of WRITTEN) void queryClient.invalidateQueries({ queryKey: key });
  };
}

function Split({ theClass, onClose }: { theClass: StudentGroup; onClose: () => void }) {
  const t = useTranslations("groups.halves");
  const tCommon = useTranslations("common");
  const written = useWritten();
  // Within the 60 characters a group's name may have, for a class whose own name is long.
  const [names, setNames] = useState([`${theClass.name.slice(0, 58)}:1`, `${theClass.name.slice(0, 58)}:2`]);
  const [busy, setBusy] = useState(false);
  const ready = names.every((name) => name.trim().length > 0);

  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/api/v1/student-groups/${theClass.id}/halves`, { names: names.map((name) => name.trim()) });
      written();
      toast.success(t("splitDone", { name: theClass.name, first: names[0]!.trim(), second: names[1]!.trim() }));
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !busy) void submit();
      }}
      className="grid gap-4"
    >
      <DialogHeader>
        <DialogTitle>{t("splitTitle", { name: theClass.name })}</DialogTitle>
        <DialogDescription>{t("splitBody")}</DialogDescription>
      </DialogHeader>
      {names.map((name, index) => (
        <FormField key={index} id={`half-name-${index}`} label={t("halfName", { n: index + 1 })}>
          <Input
            id={`half-name-${index}`}
            value={name}
            maxLength={60}
            onChange={(event) => setNames(names.map((old, at) => (at === index ? event.target.value : old)))}
          />
        </FormField>
      ))}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
          {tCommon("cancel")}
        </Button>
        <Button type="submit" disabled={!ready || busy}>
          {t("split")}
        </Button>
      </DialogFooter>
    </form>
  );
}

function Place({ theClass, onClose, groups, pupils, memberships }: ClassHalvesDialogProps & { theClass: StudentGroup }) {
  const t = useTranslations("groups.halves");
  const tCommon = useTranslations("common");
  const written = useWritten();
  const halves = useMemo(
    () => groups.filter((group) => group.halfOfId === theClass.id).sort((a, b) => a.name.localeCompare(b.name, "sv")),
    [groups, theClass.id],
  );
  // The class's pupils — or, in a rolled läsår not yet activated, the pupils of
  // the class it continues, who move into it at activation (the gateway and the
  // database read the same two).
  const classPupils = useMemo(
    () =>
      pupils
        .filter(
          (pupil) =>
            pupil.studentGroupId === theClass.id ||
            (theClass.predecessorId != null && pupil.studentGroupId === theClass.predecessorId),
        )
        .sort((a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`, "sv")),
    [pupils, theClass.id, theClass.predecessorId],
  );
  const [placement, setPlacement] = useState<Map<string, string>>(() => {
    const own = new Set(halves.map((half) => half.id));
    return new Map(
      memberships.filter((row) => own.has(row.studentGroupId)).map((row) => [row.studentId, row.studentGroupId]),
    );
  });
  const [busy, setBusy] = useState(false);
  const placed = classPupils.filter((pupil) => placement.has(pupil.id)).length;

  /** The unplaced pupils, in list order, each to the half with fewest so far. */
  const evenly = () => {
    const next = new Map(placement);
    const size = new Map(halves.map((half) => [half.id, classPupils.filter((pupil) => next.get(pupil.id) === half.id).length]));
    for (const pupil of classPupils) {
      if (next.has(pupil.id)) continue;
      const smallest = halves.reduce((best, half) => (size.get(half.id)! < size.get(best.id)! ? half : best));
      next.set(pupil.id, smallest.id);
      size.set(smallest.id, size.get(smallest.id)! + 1);
    }
    setPlacement(next);
  };

  const submit = async () => {
    setBusy(true);
    try {
      const saved = await api.put<{ placed: number; unplaced: number }>(
        `/api/v1/student-groups/${theClass.id}/halves/members`,
        {
          halves: halves.map((half) => ({
            groupId: half.id,
            studentIds: classPupils.filter((pupil) => placement.get(pupil.id) === half.id).map((pupil) => pupil.id),
          })),
        },
      );
      written();
      toast.success(t("placeDone", { name: theClass.name, placed: saved.placed, unplaced: saved.unplaced }));
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{t("placeTitle", { name: theClass.name })}</DialogTitle>
        <DialogDescription>{t("placeBody")}</DialogDescription>
      </DialogHeader>
      {classPupils.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noPupils")}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm" aria-live="polite">
              {t("summary", { placed, unplaced: classPupils.length - placed })}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={evenly} disabled={placed === classPupils.length}>
              {t("evenly")}
            </Button>
          </div>
          <ul className="max-h-80 divide-y overflow-y-auto rounded-md border">
            {classPupils.map((pupil) => {
              const name = `${pupil.firstName} ${pupil.lastName}`;
              return (
                <li key={pupil.id} className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm">
                  <span>{name}</span>
                  <NativeSelect
                    className="w-40"
                    aria-label={t("halfFor", { name })}
                    value={placement.get(pupil.id) ?? ""}
                    onChange={(event) => {
                      const next = new Map(placement);
                      if (event.target.value === "") next.delete(pupil.id);
                      else next.set(pupil.id, event.target.value);
                      setPlacement(next);
                    }}
                  >
                    <option value="">{t("noHalf")}</option>
                    {halves.map((half) => (
                      <option key={half.id} value={half.id}>
                        {half.name}
                      </option>
                    ))}
                  </NativeSelect>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
          {tCommon("cancel")}
        </Button>
        <Button type="button" onClick={() => void submit()} disabled={busy || halves.length === 0 || classPupils.length === 0}>
          {tCommon("save")}
        </Button>
      </DialogFooter>
    </div>
  );
}
