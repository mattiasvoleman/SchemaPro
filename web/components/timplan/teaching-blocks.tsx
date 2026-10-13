"use client";

// Parallella block on the Timplansposter page: the posts whose lessons the
// generator places at the same times — "Språkval åk 7" holds Spanska, Tyska
// and Franska for the teaching groups cut across 7A, 7B and 7C, and takes one
// slot of 7A's week per lesson rather than one per language.
//
// LOADED ON THE FIRST PRESS OF "BLOCK", as Mål mode is, and for the same
// reason: /admin/requirements sat at 189.4 KB of its 190 KB budget before
// blocks existed. The page imports this file by hand and keeps the namespace
// in state (see requirements-target.tsx for why not React.lazy or
// next/dynamic); the bundle gate counts what the route's manifest names, and
// this chunk is not in it.
//
// WHAT IT HOLDS. The year's blocks, read through PostgREST under the key
// ["teachingBlocks", year]; every write goes through the gateway
// (/api/v1/teaching-blocks), which answers a block whose posts differ in
// lessons or weeks with BLOCK_MEMBERS_DIFFER and a post that is in another
// block with REQUIREMENT_IN_ANOTHER_BLOCK — both in the toast, in the
// gateway's own Swedish. The posts, groups and subjects are the page's.
//
// WHAT IT SAYS BEFORE THE GENERATOR DOES. Two things the generator refuses by
// name can be seen from the page's own rows, and each block says them as soon
// as they hold: posts that share a teacher, and two posts on one group. That
// the groups share pupils is the generator's to say, from the rosters; this
// list would need every membership to say it.
//
// CONTRAST. Text is `foreground` on the card (18.69 / 15.43, AAA); the
// warnings are the Notice primitive's warning tone, measured there.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { createClient } from "@/utils/supabase/client";
import { useCrudMutations } from "@/lib/queries";
import { lengthPartsOf } from "@/lib/lesson-lengths";
import type { TeachingBlock, TeachingRequirement } from "@/lib/types";
import { useLengthsInWords } from "@/components/timplan/use-lengths-in-words";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";

const NAME_MAX = 80;

export interface BlocksHostProps {
  academicYearId: string;
  requirements: readonly TeachingRequirement[];
  groups: readonly { id: string; name: string; kind?: string }[];
  subjects: readonly { id: string; name: string }[];
}

interface BlockBody {
  academicYearId?: string;
  name: string;
  requirementIds: string[];
}

interface Draft {
  id: string | null;
  name: string;
  members: Set<string>;
}

/** The year's blocks, by name. */
function useTeachingBlocks(academicYearId: string) {
  return useQuery({
    queryKey: ["teachingBlocks", academicYearId],
    queryFn: async () => {
      const { data, error } = await createClient()
        .from("TeachingBlocks")
        .select("id, academicYearId, name")
        .eq("academicYearId", academicYearId)
        .order("name");
      if (error) throw error;
      return (data ?? []) as TeachingBlock[];
    },
  });
}

/**
 * What the generator would refuse in a block, seen from the posts alone:
 * fewer than two posts (nothing to hold together), a teacher on two posts,
 * and two posts on one group. Each as a sentence naming the posts.
 */
export type WarningText = (key: "warnOne" | "warnTeacher" | "warnGroup", values?: Record<string, string>) => string;

export function blockWarnings(
  members: readonly TeachingRequirement[],
  label: (requirement: TeachingRequirement) => string,
  t: WarningText,
): string[] {
  if (members.length < 2) return [t("warnOne")];
  const warnings: string[] = [];
  for (const [index, first] of members.entries()) {
    for (const second of members.slice(index + 1)) {
      const teachers = [first.teacherId, first.coTeacherId].filter((id): id is string => !!id);
      if ([second.teacherId, second.coTeacherId].some((id) => id && teachers.includes(id))) {
        warnings.push(t("warnTeacher", { first: label(first), second: label(second) }));
      }
      if (first.studentGroupId === second.studentGroupId) {
        warnings.push(t("warnGroup", { first: label(first), second: label(second) }));
      }
    }
  }
  return warnings;
}

export function BlocksHost({ academicYearId, requirements, groups, subjects }: BlocksHostProps) {
  const t = useTranslations("requirements.blocks");
  const tRequirements = useTranslations("requirements");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const lengthsInWords = useLengthsInWords();
  const blocks = useTeachingBlocks(academicYearId);
  const { create, update, remove } = useCrudMutations<BlockBody>("/api/v1/teaching-blocks", [
    ["teachingBlocks", academicYearId],
    ["requirements", academicYearId],
  ]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [filter, setFilter] = useState("");
  const [removing, setRemoving] = useState<TeachingBlock | null>(null);

  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const subjectName = useMemo(() => new Map(subjects.map((subject) => [subject.id, subject.name])), [subjects]);
  const label = (requirement: TeachingRequirement) =>
    tRequirements("cellLabel", {
      subject: subjectName.get(requirement.subjectId) ?? "",
      group: groupById.get(requirement.studentGroupId)?.name ?? "",
    });
  // Teaching groups first — where a block's posts usually are — then by name.
  const rows = useMemo(
    () =>
      [...requirements].sort((a, b) => {
        const ga = groupById.get(a.studentGroupId);
        const gb = groupById.get(b.studentGroupId);
        const kind = Number(ga?.kind !== "TEACHING_GROUP") - Number(gb?.kind !== "TEACHING_GROUP");
        return (
          kind ||
          (ga?.name ?? "").localeCompare(gb?.name ?? "", "sv") ||
          (subjectName.get(a.subjectId) ?? "").localeCompare(subjectName.get(b.subjectId) ?? "", "sv")
        );
      }),
    [requirements, groupById, subjectName],
  );
  const membersOf = (blockId: string) => rows.filter((requirement) => requirement.blockId === blockId);
  const blockName = useMemo(
    () => new Map((blocks.data ?? []).map((block) => [block.id, block.name])),
    [blocks.data],
  );

  const open = (block: TeachingBlock | null) => {
    setFilter("");
    setDraft({
      id: block?.id ?? null,
      name: block?.name ?? "",
      members: new Set(block ? membersOf(block.id).map((requirement) => requirement.id) : []),
    });
  };
  const trimmed = draft?.name.trim() ?? "";
  const nameProblem = trimmed.length === 0 ? "nameMissing" : trimmed.length > NAME_MAX ? "nameTooLong" : null;
  const saving = create.isPending || update.isPending;

  const save = async () => {
    if (!draft || nameProblem) return;
    const body = { name: trimmed, requirementIds: [...draft.members] };
    try {
      if (draft.id) await update.mutateAsync({ id: draft.id, ...body });
      else await create.mutateAsync({ academicYearId, ...body });
      toast.success(t("saved", { name: trimmed }));
      setDraft(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };
  const confirmRemove = async () => {
    if (!removing) return;
    try {
      await remove.mutateAsync(removing.id);
      toast.success(t("removed", { name: removing.name }));
      setRemoving(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const needle = filter.trim().toLocaleLowerCase("sv");
  const listed = needle
    ? rows.filter((requirement) => label(requirement).toLocaleLowerCase("sv").includes(needle))
    : rows;

  return (
    <SectionCard
      id="teaching-blocks"
      title={t("title")}
      description={t("description")}
      descriptionClassName="text-foreground"
      action={
        <Button variant="outline" size="sm" onClick={() => open(null)}>
          {t("new")}
        </Button>
      }
    >
      {blocks.isLoading ? (
        <Skeleton className="h-16 w-full" aria-busy="true" />
      ) : blocks.isError ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={3} />
      ) : (blocks.data ?? []).length === 0 ? (
        <p className="text-sm text-foreground">{t("empty")}</p>
      ) : (
        <ul className="divide-y">
          {(blocks.data ?? []).map((block) => {
            const members = membersOf(block.id);
            const warnings = blockWarnings(members, label, t as WarningText);
            return (
              <li key={block.id} className="space-y-2 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-medium">{block.name}</h3>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={t("editNamed", { name: block.name })}
                      onClick={() => open(block)}
                    >
                      {t("edit")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={t("removeNamed", { name: block.name })}
                      onClick={() => setRemoving(block)}
                    >
                      {t("remove")}
                    </Button>
                  </div>
                </div>
                <p className="text-sm text-foreground">
                  {members.length === 0
                    ? t("noMembers")
                    : t("members", {
                        lessons: lengthsInWords(lengthPartsOf(members[0]!)),
                        posts: new Intl.ListFormat(locale, { type: "conjunction" }).format(members.map(label)),
                      })}
                </p>
                {warnings.length > 0 ? (
                  <Notice tone="warning" role={null}>
                    <ul className="list-disc space-y-1 pl-4">
                      {warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </Notice>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={draft !== null} onOpenChange={(next) => !next && !saving && setDraft(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{draft?.id ? t("editTitle") : t("newTitle")}</DialogTitle>
            <DialogDescription>{t("dialogDescription")}</DialogDescription>
          </DialogHeader>
          {draft ? (
            <div className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="block-name">{t("name")}</Label>
                <Input
                  id="block-name"
                  value={draft.name}
                  maxLength={NAME_MAX + 20}
                  aria-invalid={draft.name.length > 0 && nameProblem !== null ? true : undefined}
                  aria-describedby="block-name-hint"
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
                <p
                  id="block-name-hint"
                  className={draft.name.length > 0 && nameProblem ? "text-xs text-destructive" : "text-xs text-foreground"}
                >
                  {draft.name.length > 0 && nameProblem ? t(nameProblem, { max: NAME_MAX }) : t("nameHint")}
                </p>
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">
                  {t("posts", { count: draft.members.size })}
                </legend>
                <Input
                  type="search"
                  aria-label={t("filter")}
                  placeholder={t("filter")}
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
                <ul className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-2">
                  {listed.map((requirement) => {
                    const elsewhere =
                      requirement.blockId && requirement.blockId !== draft.id
                        ? (blockName.get(requirement.blockId) ?? "")
                        : null;
                    return (
                      <li key={requirement.id}>
                        <label className="flex items-start gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="mt-0.5 size-4 accent-primary"
                            checked={draft.members.has(requirement.id)}
                            disabled={elsewhere !== null}
                            onChange={(event) => {
                              const members = new Set(draft.members);
                              if (event.target.checked) members.add(requirement.id);
                              else members.delete(requirement.id);
                              setDraft({ ...draft, members });
                            }}
                          />
                          <span>
                            {label(requirement)}
                            <span className="ml-1 text-foreground">· {lengthsInWords(lengthPartsOf(requirement))}</span>
                            {elsewhere !== null ? (
                              <span className="block text-xs text-foreground">{t("inOther", { name: elsewhere })}</span>
                            ) : null}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <p className="text-xs text-foreground">{t("postsHint")}</p>
              </fieldset>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={() => setDraft(null)}>
              {tCommon("cancel")}
            </Button>
            <Button disabled={saving || nameProblem !== null} onClick={() => void save()}>
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => !next && setRemoving(null)}
        title={t("removeTitle", { name: removing?.name ?? "" })}
        description={t("removeBody")}
        confirmLabel={t("remove")}
        loading={remove.isPending}
        onConfirm={() => void confirmRemove()}
      />
    </SectionCard>
  );
}
