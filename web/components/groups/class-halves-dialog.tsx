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

import { useMemo, useState } from "react";
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

export interface ClassHalvesDialogProps {
  /** Which dialog, for which class; null: closed. */
  opened: { mode: "split" | "place"; theClass: StudentGroup } | null;
  onClose: () => void;
  groups: readonly StudentGroup[];
  pupils: readonly HalvesPupil[];
  memberships: ReadonlyArray<{ studentId: string; studentGroupId: string }>;
}

/** What a split or a placement changes: the groups, the counts, and who sits where. */
const WRITTEN = [["groups"], ["people", "yearRosters"], ["groupMemberships"], ["groupMembers"], ["lessonRoster"]];

export function ClassHalvesDialog(props: ClassHalvesDialogProps) {
  const { opened, onClose } = props;
  return (
    <Dialog open={opened !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        {opened?.mode === "split" ? <Split key={opened.theClass.id} theClass={opened.theClass} onClose={onClose} /> : null}
        {opened?.mode === "place" ? <Place key={opened.theClass.id} {...props} theClass={opened.theClass} /> : null}
      </DialogContent>
    </Dialog>
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
  const [names, setNames] = useState([`${theClass.name}:1`, `${theClass.name}:2`]);
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
      await api.put(`/api/v1/student-groups/${theClass.id}/halves/members`, {
        halves: halves.map((half) => ({
          groupId: half.id,
          studentIds: classPupils.filter((pupil) => placement.get(pupil.id) === half.id).map((pupil) => pupil.id),
        })),
      });
      written();
      toast.success(t("placeDone", { name: theClass.name }));
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
        <Button type="button" onClick={() => void submit()} disabled={busy || halves.length === 0}>
          {tCommon("save")}
        </Button>
      </DialogFooter>
    </div>
  );
}
