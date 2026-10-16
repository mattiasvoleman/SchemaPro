"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CalendarRange, Pencil, Plus, Split, Trash2, Upload, UserPlus, Users } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { LazyCsvImportDialog } from "@/components/import/lazy-csv-import-dialog";
import { LazyClassHalvesDialog } from "@/components/groups/lazy-class-halves-dialog";
import { CsvExportButton } from "@/components/import/csv-export-button";
import { classesToCsv, membershipsToCsv } from "@/lib/csv-export";
import {
  useAcademicYears,
  useCrudMutations,
  useGroupMembers,
  useGroupMemberships,
  useGroups,
  usePeople,
  useSetGroupMembers,
} from "@/lib/queries";
import type { StudentGroup } from "@/lib/types";
import { GROUP_WRITE_KEYS } from "@/lib/projected-rosters";
import { SchoolUnitsCard } from "./school-units-card";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  buildGroupMemberNames,
  countGroupMembers,
} from "@/lib/group-sections";
import { filterByQuery, matchesQuery } from "@/lib/search";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FilterBar } from "@/components/ui/filter-bar";
import { FormField } from "@/components/ui/form-field";
import { LoadError } from "@/components/ui/load-error";
import { RowActions, type RowAction } from "@/components/ui/row-actions";
import { SearchField } from "@/components/ui/search-field";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCard } from "@/components/ui/table-card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface GroupForm {
  name: string;
  gradeLevel: string;
  kind: "CLASS" | "TEACHING_GROUP";
  academicYearId: string;
}

/**
 * Klasser: every läsår's groups in one list, with a Läsår column.
 *
 * Not scoped to one year. Between a rollover and its activation every class
 * exists twice, this year's 7A beside next year's 8A, and the Läsår column
 * and the search tell them apart: "ma71 2026" narrows a name that recurs
 * across läsår (manual 3.4). Generate's "groups without an årskurs" notice
 * names groups of the year being planned, which need not be the active one,
 * and sends the reader here to find them; a list of one year would hide them.
 */
export default function GroupsPage() {
  const t = useTranslations("groups");
  const tCommon = useTranslations("common");
  const tSetup = useTranslations("setup");
  const tYears = useTranslations("years");
  const tCsvImport = useTranslations("csvImport");
  const groupsQuery = useGroups();
  const groups = groupsQuery.data;
  const yearsQuery = useAcademicYears();
  const years = useMemo(() => yearsQuery.data ?? [], [yearsQuery.data]);
  const peopleQuery = usePeople();
  const people = peopleQuery.data;
  const mutations = useCrudMutations<{
    name: string;
    gradeLevel?: number | null;
    kind?: "CLASS" | "TEACHING_GROUP";
    academicYearId: string;
  }>("/api/v1/student-groups", GROUP_WRITE_KEYS);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<StudentGroup | null>(null);
  const [deleting, setDeleting] = useState<StudentGroup | null>(null);
  const [membersFor, setMembersFor] = useState<StudentGroup | null>(null);
  // Halvklasser: "Dela klassen" or "Placera elever", for one class.
  const [halvesFor, setHalvesFor] = useState<{ mode: "split" | "place"; theClass: StudentGroup } | null>(null);
  const [kindFilter, setKindFilter] = useState<"ALL" | "CLASS" | "TEACHING_GROUP">(
    "ALL",
  );
  const [search, setSearch] = useState("");
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [memberSearch, setMemberSearch] = useState("");
  const membersQuery = useGroupMembers(membersFor?.id ?? null);
  const currentMembers = membersQuery.data;
  /*
   * Saving REPLACES the group's members with the ticked boxes. Until the
   * stored members (and the pupils to tick) have arrived every box is
   * unticked, so a save then would empty the group: the list and the save
   * wait for both, and a failed read says so instead of an empty list.
   */
  const membersLoading = membersFor !== null && (membersQuery.isLoading || peopleQuery.isLoading);
  const membersFailed = membersFor !== null && (membersQuery.isError || peopleQuery.isError);
  const membershipsQuery = useGroupMemberships();
  const memberships = membershipsQuery.data;
  const setMembers = useSetGroupMembers();

  // The active year's classes, for the skolenheter card's map.
  const activeClasses = useMemo(() => {
    const active = years.find((year) => year.isActive);
    return (groups ?? []).filter((group) => group.kind === "CLASS" && group.academicYearId === active?.id);
  }, [groups, years]);

  const students = useMemo(
    () =>
      (people ?? []).filter(
        (person) => person.role === "STUDENT" && person.isActive,
      ),
    [people],
  );

  const openMembers = (group: StudentGroup) => {
    setMemberSearch("");
    setMembersFor(group);
  };

  // Preload the checkbox state once the current membership arrives.
  const membersKey = (currentMembers ?? []).map((m) => m.id).join(",");
  useEffect(() => {
    if (membersFor) setMemberIds(new Set((currentMembers ?? []).map((m) => m.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membersFor?.id, membersKey]);

  const toggleMember = (id: string) => {
    setMemberIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const saveMembers = async () => {
    if (!membersFor) return;
    try {
      const { count } = await setMembers.mutateAsync({
        groupId: membersFor.id,
        studentIds: [...memberIds],
      });
      toast.success(t("membersSaved", { count }));
      setMembersFor(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };
  const [form, setForm] = useState<GroupForm>({
    name: "",
    gradeLevel: "",
    kind: "CLASS",
    academicYearId: "",
  });

  // Group id → the people in it, so the search below can find a group by the
  // name of a student in it. See lib/group-sections.ts.
  const memberNames = useMemo(
    () => buildGroupMemberNames(people ?? [], memberships ?? []),
    [people, memberships],
  );

  // Sizes come from two different places depending on the kind of group —
  // see lib/group-sections.ts, where the rule and its tests live.
  const memberCounts = useMemo(
    () => countGroupMembers(people ?? [], memberships ?? []),
    [people, memberships],
  );

  /** Group id → the group, for a half's class (Halvklasser). */
  const groupById = useMemo(() => new Map((groups ?? []).map((group) => [group.id, group])), [groups]);

  /** Läsår id → its name, for the Läsår column and the search. */
  const yearNames = useMemo(() => new Map(years.map((year) => [year.id, year.name])), [years]);

  const visibleGroups = useMemo(() => {
    const byKind = (groups ?? []).filter(
      (group) => kindFilter === "ALL" || group.kind === kindFilter,
    );
    // Searchable by group name, by year — "ma71 2026" narrows a name that
    // recurs across läsår — and by the names of its students, which is how an
    // admin answers "which teaching group is Alma in?".
    return filterByQuery(byKind, search, (group) => [
      group.name,
      yearNames.get(group.academicYearId) ?? "",
      ...(memberNames.get(group.id) ?? []).map((member) => member.name),
    ]);
  }, [groups, kindFilter, search, yearNames, memberNames]);

  /** A new group goes into the active läsår unless the dialog is told otherwise. */
  const defaultYearId = years.find((year) => year.isActive)?.id ?? years[0]?.id ?? "";

  /**
   * The students in this group that the current search matched — shown under
   * the group name so "which group is Alma in?" is answered on screen, not
   * merely implied by the row appearing.
   */
  const matchingMembers = (groupId: string) => {
    if (search.trim() === "") return [];
    return (memberNames.get(groupId) ?? []).filter((member) =>
      matchesQuery([member.name], search),
    );
  };

  const openCreate = () => {
    setEditing(null);
    setForm({ name: "", gradeLevel: "", kind: "CLASS", academicYearId: defaultYearId });
    setDialogOpen(true);
  };

  const openEdit = (group: StudentGroup) => {
    setEditing(group);
    setForm({
      name: group.name,
      gradeLevel: group.gradeLevel !== null ? String(group.gradeLevel) : "",
      kind: group.kind,
      academicYearId: group.academicYearId,
    });
    setDialogOpen(true);
  };

  const submit = async () => {
    const gradeLevel = form.gradeLevel.trim() === "" ? null : Number(form.gradeLevel);
    const body = {
      name: form.name.trim(),
      gradeLevel: gradeLevel !== null && Number.isFinite(gradeLevel) ? gradeLevel : null,
      kind: form.kind,
      academicYearId: form.academicYearId,
    };
    try {
      if (editing) {
        await mutations.update.mutateAsync({ id: editing.id, ...body });
        toast.success(tCommon("updated"));
      } else {
        await mutations.create.mutateAsync(body);
        toast.success(tCommon("created"));
      }
      setDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await mutations.remove.mutateAsync(deleting.id);
      toast.success(tCommon("deleted"));
      setDeleting(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const loading = groupsQuery.isLoading || yearsQuery.isLoading;
  const failed = groupsQuery.isError || yearsQuery.isError;
  const hasYears = years.length > 0;
  /*
   * The Elever column is counted from the people and the memberships, two
   * reads of their own. Until both have answered a count is not known, and
   * when either failed it is not 0: the cell says "—" and a notice says why,
   * rather than a column of zeros that reads as empty classes.
   */
  const countsFailed = peopleQuery.isError || membershipsQuery.isError;
  // What the placement dialog may draw from (ClassHalvesDialog's `reads`).
  // Asked again, it is loading, whatever the last answer was: a retry after
  // a failure waits for its own answer.
  const placementReads =
    peopleQuery.isFetching || membershipsQuery.isFetching
      ? "loading"
      : countsFailed
        ? "failed"
        : people === undefined || memberships === undefined
          ? "loading"
          : "ready";
  const placementReadsAt = Math.min(peopleQuery.dataUpdatedAt ?? 0, membershipsQuery.dataUpdatedAt ?? 0);
  const pastYearIds = useMemo(() => {
    const active = years.find((year) => year.isActive);
    return new Set(active ? years.filter((year) => year.endDate < active.startDate).map((year) => year.id) : []);
  }, [years]);
  const countsKnown = people !== undefined && memberships !== undefined && !countsFailed;

  /*
   * A class splits once ("Dela klassen") and then places its pupils; a half
   * places them for its class, in the same dialog, rather than in the member
   * list a teaching group has — a half takes its class's pupils only.
   */
  const halvesAction = (group: StudentGroup): RowAction[] => {
    const theClass = group.halfOfId ? groupById.get(group.halfOfId) : group.kind === "CLASS" ? group : undefined;
    // A läsår that ended before the active one began is history: its pupils
    // are in next year's classes, and its halves keep who was in them.
    if (!theClass || pastYearIds.has(theClass.academicYearId)) return [];
    const split = !(groups ?? []).some((other) => other.halfOfId === theClass.id);
    return [
      {
        key: "halves",
        label: split ? t("halves.split") : t("halves.place"),
        icon: split ? Split : UserPlus,
        ariaLabel: t(split ? "halves.splitTitle" : "halves.placeTitle", { name: theClass.name }),
        onSelect: () => setHalvesFor({ mode: split ? "split" : "place", theClass }),
      },
    ];
  };

  /*
   * What goes with a delete, said before it: a split class takes its halves,
   * their timplansposter and lessons; a half leaves its class with one half,
   * which is not split again until that one is gone too.
   */
  const deleteBody = (group: StudentGroup | null): string => {
    if (!group) return tCommon("deleteConfirmBody");
    const halvesOf = (groups ?? []).filter((other) => other.halfOfId === group.id).map((half) => half.name);
    if (halvesOf.length > 0) {
      return `${t("halves.deleteClass", { halves: halvesOf.sort((a, b) => a.localeCompare(b, "sv")).join(", ") })} ${tCommon("deleteConfirmBody")}`;
    }
    const theClass = group.halfOfId ? groupById.get(group.halfOfId) : undefined;
    if (theClass) return `${t("halves.deleteHalf", { name: theClass.name })} ${tCommon("deleteConfirmBody")}`;
    return tCommon("deleteConfirmBody");
  };

  const actionsOf = (group: StudentGroup): RowAction[] => [
    ...halvesAction(group),
    ...(group.kind === "TEACHING_GROUP" && !group.halfOfId
      ? [
          {
            label: t("members"),
            icon: UserPlus,
            ariaLabel: t("membersTitle", { name: group.name }),
            onSelect: () => openMembers(group),
          },
        ]
      : []),
    {
      label: tCommon("edit"),
      icon: Pencil,
      ariaLabel: tCommon("editNamed", { name: group.name }),
      onSelect: () => openEdit(group),
    },
    {
      label: tCommon("delete"),
      icon: Trash2,
      ariaLabel: tCommon("deleteNamed", { name: group.name }),
      onSelect: () => setDeleting(group),
    },
  ];

  return (
    <Page>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <>
            <CsvExportButton
              exports={[
                {
                  kind: "classes",
                  build: () => classesToCsv(groups ?? []),
                  empty: !groups?.some((group) => group.kind === "CLASS"),
                },
                {
                  kind: "teachingGroups",
                  build: () =>
                    membershipsToCsv(groups ?? [], people ?? [], memberships ?? []),
                  empty: !memberships || memberships.length === 0,
                },
              ]}
            />
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Upload aria-hidden="true" />
              {tCsvImport("button")}
            </Button>
            <Button onClick={openCreate} disabled={!hasYears}>
              <Plus aria-hidden="true" />
              {t("addGroup")}
            </Button>
          </>
        }
      />

      {loading || failed || hasYears ? (
        <FilterBar>
          <Tabs
            value={kindFilter}
            onValueChange={(value) => setKindFilter(value as typeof kindFilter)}
          >
            <TabsList aria-label={t("kindLabel")}>
              <TabsTrigger value="ALL">{t("filterAll")}</TabsTrigger>
              <TabsTrigger value="CLASS">{t("kindClass")}</TabsTrigger>
              <TabsTrigger value="TEACHING_GROUP">{t("kindTeachingGroup")}</TabsTrigger>
            </TabsList>
          </Tabs>
          <SearchField
            id="groups-search"
            label={t("searchLabel")}
            value={search}
            onValueChange={setSearch}
          />
        </FilterBar>
      ) : null}

      {loading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : failed ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : !hasYears ? (
        <EmptyState
          icon={CalendarRange}
          title={t("noYearTitle")}
          description={t("noYearHint")}
          headingLevel={2}
          action={
            <Button asChild>
              <Link href="/admin/years">{t("noYearAction")}</Link>
            </Button>
          }
        />
      ) : !groups || groups.length === 0 ? (
        <EmptyState
          icon={Users}
          title={t("emptyTitle")}
          description={t("emptyHint")}
          headingLevel={2}
          action={
            <Button onClick={openCreate}>
              <Plus aria-hidden="true" />
              {t("addGroup")}
            </Button>
          }
        />
      ) : (
        <>
          {countsFailed ? (
            <LoadError variant="inline" title={t("countsFailed")} hint={t("countsFailedHint")} />
          ) : null}
          <TableCard caption={t("tableCaption")}>
            <TableHeader>
              <TableRow>
                <TableHead>{tCommon("name")}</TableHead>
                <TableHead>{t("year")}</TableHead>
                <TableHead className="text-right">{tCommon("students")}</TableHead>
                <TableHead className="w-32 text-right">{tCommon("actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleGroups.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                    {t("noMatch")}
                  </TableCell>
                </TableRow>
              ) : null}
              {visibleGroups.map((group) => {
                const matched = matchingMembers(group.id);
                return (
                  <TableRow key={group.id}>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{group.name}</span>
                        <Badge variant={group.kind === "CLASS" ? "secondary" : "outline"}>
                          {group.kind === "CLASS" ? t("kindClass") : t("kindTeachingGroup")}
                        </Badge>
                        {group.halfOfId ? (
                          <Badge variant="outline">
                            {t("halves.badge", { name: groupById.get(group.halfOfId)?.name ?? "" })}
                          </Badge>
                        ) : null}
                        {group.gradeLevel !== null ? (
                          <Badge variant="secondary">
                            {tYears("gradeShort", { grade: group.gradeLevel })}
                          </Badge>
                        ) : null}
                      </div>
                      {matched.length > 0 ? (
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {matched
                            .slice(0, 3)
                            .map((member) => member.name)
                            .join(", ")}
                          {matched.length > 3 ? t("andMore", { count: matched.length - 3 }) : ""}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {yearNames.get(group.academicYearId) ?? (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {countsKnown ? (
                        memberCounts.get(group.id) ?? 0
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <RowActions name={group.name} actions={actionsOf(group)} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </TableCard>
        </>
      )}

      <SchoolUnitsCard classes={activeClasses} />

      <LazyClassHalvesDialog
        opened={halvesFor}
        onClose={() => setHalvesFor(null)}
        groups={groups ?? []}
        pupils={students}
        memberships={memberships ?? []}
        reads={placementReads}
        readsAt={placementReadsAt}
      />

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? t("editGroup") : t("addGroup")}</DialogTitle>
            <DialogDescription>{t("dialogHint")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <FormField
              id="group-kind"
              label={t("kindLabel")}
              hint={form.kind === "CLASS" ? t("kindClassHelp") : t("kindTeachingGroupHelp")}
            >
              {(control) => (
                <Select
                  value={form.kind}
                  onValueChange={(value) =>
                    setForm({ ...form, kind: value as GroupForm["kind"] })
                  }
                >
                  <SelectTrigger {...control}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CLASS">{t("kindClass")}</SelectItem>
                    <SelectItem value="TEACHING_GROUP">{t("kindTeachingGroup")}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
              <FormField id="group-name" label={tCommon("name")}>
                <Input
                  value={form.name}
                  placeholder={t("namePlaceholder")}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </FormField>
              <FormField id="group-grade" label={tSetup("gradeLevel")} optional>
                <Input
                  type="number"
                  min={0}
                  max={12}
                  value={form.gradeLevel}
                  onChange={(e) => setForm({ ...form, gradeLevel: e.target.value })}
                />
              </FormField>
            </div>
            <FormField id="group-year" label={t("year")}>
              {(control) => (
                <Select
                  value={form.academicYearId}
                  onValueChange={(value) => setForm({ ...form, academicYearId: value })}
                >
                  <SelectTrigger {...control}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {years.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button
              onClick={submit}
              disabled={
                form.name.trim().length === 0 ||
                form.academicYearId === "" ||
                mutations.create.isPending ||
                mutations.update.isPending
              }
            >
              {tCommon("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={membersFor !== null} onOpenChange={(open) => !open && setMembersFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("membersTitle", { name: membersFor?.name ?? "" })}
            </DialogTitle>
            <DialogDescription>{t("membersHint")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <SearchField
              id="group-member-search"
              label={t("memberSearch")}
              value={memberSearch}
              onValueChange={setMemberSearch}
              className="max-w-none"
            />
            {membersLoading ? (
              <div aria-busy="true">
                <Skeleton className="h-24 w-full" />
              </div>
            ) : membersFailed ? (
              <LoadError
                variant="inline"
                title={t("membersLoadFailed")}
                hint={t("membersLoadFailedHint")}
              />
            ) : (
              <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
                {students
                  .filter((student) =>
                    `${student.firstName} ${student.lastName}`
                      .toLowerCase()
                      .includes(memberSearch.toLowerCase()),
                  )
                  .map((student) => (
                    <li key={student.id}>
                      <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-muted/50">
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={memberIds.has(student.id)}
                          onChange={() => toggleMember(student.id)}
                        />
                        <span className="flex-1">
                          {student.firstName} {student.lastName}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {groups?.find((g) => g.id === student.studentGroupId)?.name ?? ""}
                        </span>
                      </label>
                    </li>
                  ))}
              </ul>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMembersFor(null)}>
              {tCommon("cancel")}
            </Button>
            <Button
              onClick={saveMembers}
              disabled={setMembers.isPending || membersLoading || membersFailed}
            >
              {t("membersSave", { count: memberIds.size })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <LazyCsvImportDialog
        kinds={["classes", "teachingGroups"]}
        open={importOpen}
        onOpenChange={setImportOpen}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={tCommon("deleteConfirmTitle", { name: deleting?.name ?? "" })}
        description={deleteBody(deleting)}
        confirmLabel={tCommon("delete")}
        loading={mutations.remove.isPending}
        onConfirm={confirmDelete}
      />
    </Page>
  );
}
