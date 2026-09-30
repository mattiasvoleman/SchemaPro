"use client";

import { Fragment, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  ChevronRight,
  Link2,
  Mail,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
  UserCheck,
} from "lucide-react";
import { CsvImportDialog } from "@/components/import/csv-import-dialog";
import { CsvExportButton } from "@/components/import/csv-export-button";
import { studentsToCsv, teachersToCsv } from "@/lib/csv";
import {
  useCrudMutations,
  useAcademicYears,
  useGroupMemberships,
  useGroups,
  useGuardianLinkActions,
  useInvitations,
  usePeople,
  useRequirements,
  useSubjects,
  useStudentGuardians,
} from "@/lib/queries";
import type { Person, StudentGroup, UserRole } from "@/lib/types";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { filterByQuery } from "@/lib/search";
import {
  taughtGroupsOf,
  teachingGroupsOf,
  type TaughtGroup,
} from "@/lib/group-sections";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const ROLES: UserRole[] = ["STUDENT", "TEACHER", "SCHOOL_ADMIN", "GUARDIAN"];
const NO_GROUP = "__none__";

interface PersonForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  role: UserRole;
  studentGroupId: string;
}

const EMPTY_FORM: PersonForm = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  role: "STUDENT",
  studentGroupId: NO_GROUP,
};

/**
 * What is only worth seeing for one person at a time.
 *
 * A student's teaching groups and a teacher's assignments are both answers to
 * the same question from opposite sides, and neither belongs in a column: a
 * student can be in half a dozen groups, which would either be truncated into
 * uselessness or turn every row into three. Behind a click they can be shown
 * in full.
 */
function PersonDetail({
  person,
  homeClass,
  teachingGroups,
  taught,
  subjectName,
  t,
}: {
  person: Person;
  homeClass: string;
  teachingGroups: StudentGroup[];
  taught: TaughtGroup[];
  subjectName: (id: string) => string;
  t: (key: string, values?: Record<string, string | number>) => string;
}) {
  if (person.role === "TEACHER") {
    return (
      <div className="space-y-1.5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("teachesLabel")}
        </p>
        {taught.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("teachesNothing")}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {taught.map((entry) => (
              <Badge
                key={`${entry.group.id}-${entry.subjectId}`}
                variant="outline"
                className="font-normal"
              >
                {entry.group.name} · {subjectName(entry.subjectId)}
                {entry.isCoTeacher ? ` (${t("asCoTeacher")})` : ""}
              </Badge>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (person.role !== "STUDENT") {
    return <p className="text-sm text-muted-foreground">{t("noGroupInfo")}</p>;
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("homeClassLabel")}
        </p>
        <p className="text-sm">{homeClass}</p>
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("teachingGroupsLabel")}
        </p>
        {teachingGroups.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noTeachingGroups")}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {teachingGroups.map((group) => (
              <Badge key={group.id} variant="outline" className="font-normal">
                {group.name}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function PeoplePage() {
  const t = useTranslations("people");
  const tCommon = useTranslations("common");
  const tRoles = useTranslations("roles");
  const tCsvImport = useTranslations("csvImport");
  const { data: people, isLoading } = usePeople();
  const { data: groups } = useGroups();
  const { data: memberships } = useGroupMemberships();
  const { data: subjects } = useSubjects();
  const { data: years } = useAcademicYears();
  const activeYearId = years?.find((year) => year.isActive)?.id ?? years?.[0]?.id ?? null;
  const { data: requirements } = useRequirements(activeYearId);
  const [guardiansFor, setGuardiansFor] = useState<Person | null>(null);
  const { data: studentGuardians } = useStudentGuardians(guardiansFor?.id ?? null);
  const guardianLinks = useGuardianLinkActions();
  const [newGuardianId, setNewGuardianId] = useState("");
  const mutations = useCrudMutations<{
    firstName: string;
    lastName: string;
    email?: string;
    phone?: string | null;
    role?: UserRole;
    studentGroupId?: string | null;
    isActive?: boolean;
    /** Opt-in only; see the toggle in the create dialog. */
    sendInvitation?: boolean;
  }>("/api/v1/users", [["people"]]);

  const [filter, setFilter] = useState<"ALL" | UserRole>("ALL");
  const [search, setSearch] = useState("");
  /** Which person's detail row is open; one at a time keeps the table readable. */
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const subjectName = (id: string) =>
    subjects?.find((subject) => subject.id === id)?.name ?? "—";

  /** Class name for export: blank rather than an em dash when there is none. */
  const exportClassName = (id: string | null) =>
    id ? (groups?.find((group) => group.id === id)?.name ?? "") : "";

  const groupName = (id: string | null) =>
    id ? (groups?.find((group) => group.id === id)?.name ?? "—") : "—";
  const [dialogOpen, setDialogOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<Person | null>(null);
  const [deleting, setDeleting] = useState<Person | null>(null);
  const [form, setForm] = useState<PersonForm>(EMPTY_FORM);
  const [sendInvitation, setSendInvitation] = useState(false);
  const invitations = useInvitations();

  const filtered = useMemo(() => {
    if (!people) return [];
    const byRole =
      filter === "ALL" ? people : people.filter((person) => person.role === filter);
    // Name, email and class: the three things an admin actually has to hand
    // when they are looking for somebody.
    return filterByQuery(byRole, search, (person) => [
      person.firstName,
      person.lastName,
      person.email,
      groupName(person.studentGroupId),
    ]);
  }, [people, filter, search, groups]);

  /**
   * Active people who have never been contacted — what "invite all" targets.
   *
   * Derived from the FILTERED list on purpose: with a role tab or a search
   * active, the button invites exactly the people on screen, which is how an
   * admin invites one class at a time. The count in its label is what makes
   * that honest, so it must keep coming from the same list.
   */
  const uninvited = useMemo(
    () => filtered.filter((person) => person.invitedAt === null && person.isActive),
    [filtered],
  );

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    // Off every time the dialog opens: an invitation is a decision, never a
    // setting that quietly carries over from the last person added.
    setSendInvitation(false);
    setDialogOpen(true);
  };

  const openEdit = (person: Person) => {
    setEditing(person);
    setForm({
      firstName: person.firstName,
      lastName: person.lastName,
      email: person.email,
      phone: person.phone ?? "",
      role: person.role,
      studentGroupId: person.studentGroupId ?? NO_GROUP,
    });
    setDialogOpen(true);
  };

  const submit = async () => {
    const body = {
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      phone: form.phone.trim() || null,
      role: form.role,
      studentGroupId:
        form.role === "STUDENT" && form.studentGroupId !== NO_GROUP
          ? form.studentGroupId
          : null,
    };
    try {
      if (editing) {
        await mutations.update.mutateAsync({ id: editing.id, ...body });
        toast.success(tCommon("updated"));
      } else {
        await mutations.create.mutateAsync({
          ...body,
          email: form.email.trim(),
          sendInvitation,
        });
        toast.success(sendInvitation ? t("createdAndInvited") : tCommon("created"));
      }
      setDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const inviteOne = async (person: Person) => {
    try {
      const result = await invitations.inviteOne.mutateAsync(person.id);
      toast.success(
        result.emailSent
          ? t("invitationSent", { name: person.firstName })
          : t("invitationAlreadyRegistered", { name: person.firstName }),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const inviteAllUninvited = async () => {
    try {
      const report = await invitations.inviteMany.mutateAsync(
        uninvited.map((person) => person.id),
      );
      // Report what actually happened rather than the count asked for: some
      // addresses already have accounts and receive nothing.
      toast.success(
        t("invitationsSent", {
          sent: report.sent,
          skipped: report.alreadyRegistered,
        }),
      );
      if (report.errors.length > 0) {
        toast.error(t("invitationsFailed", { count: report.errors.length }));
      }
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

  return (
    <div>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <>
            {uninvited.length > 0 ? (
              <Button
                variant="outline"
                onClick={() => void inviteAllUninvited()}
                disabled={invitations.inviteMany.isPending}
              >
                <Mail />
                {t("inviteAll", { count: uninvited.length })}
              </Button>
            ) : null}
            <CsvExportButton
              exports={[
                {
                  kind: "teachers",
                  build: () => teachersToCsv(people ?? []),
                  empty: !people?.some((person) => person.role === "TEACHER"),
                },
                {
                  kind: "students",
                  // Not `groupName`: that renders an em dash for "no class",
                  // and an exported file saying "—" is one the importer would
                  // reject on the way back in.
                  build: () => studentsToCsv(people ?? [], exportClassName),
                  empty: !people?.some((person) => person.role === "STUDENT"),
                },
              ]}
            />
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Upload />
              {tCsvImport("button")}
            </Button>
            <Button onClick={openCreate}>
              <Plus />
              {t("addPerson")}
            </Button>
          </>
        }
      />

      <Tabs
        value={filter}
        onValueChange={(value) => setFilter(value as "ALL" | UserRole)}
        className="mb-4"
      >
        <TabsList>
          <TabsTrigger value="ALL">{t("filterAll")}</TabsTrigger>
          {ROLES.map((role) => (
            <TabsTrigger key={role} value={role}>
              {tRoles(role)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="relative mb-4 max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchPlaceholder")}
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={UserCheck} title={tCommon("noResults")} description={t("empty")} />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tCommon("name")}</TableHead>
                <TableHead>{t("email")}</TableHead>
                <TableHead>{t("role")}</TableHead>
                <TableHead>{t("class")}</TableHead>
                <TableHead>{tCommon("status")}</TableHead>
                <TableHead>{t("invitationState")}</TableHead>
                <TableHead className="w-24 text-right">{tCommon("actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((person) => (
                <Fragment key={person.id}>
                <TableRow>
                  <TableCell className="font-medium">
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedId(expandedId === person.id ? null : person.id)
                      }
                      aria-expanded={expandedId === person.id}
                      aria-controls={`person-detail-${person.id}`}
                      className="flex items-center gap-1.5 text-left hover:underline"
                    >
                      <ChevronRight
                        className={
                          expandedId === person.id
                            ? "h-3.5 w-3.5 rotate-90 transition-transform"
                            : "h-3.5 w-3.5 transition-transform"
                        }
                      />
                      {person.firstName} {person.lastName}
                    </button>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{person.email}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{tRoles(person.role)}</Badge>
                  </TableCell>
                  <TableCell>{groupName(person.studentGroupId)}</TableCell>
                  <TableCell>
                    {person.isActive ? (
                      <Badge variant="success">{t("activeState")}</Badge>
                    ) : (
                      <Badge variant="outline">{t("inactive")}</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {person.invitedAt ? (
                      <Badge variant="secondary">{t("invited")}</Badge>
                    ) : (
                      <Badge variant="outline">{t("notInvited")}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {person.isActive ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void inviteOne(person)}
                        disabled={invitations.inviteOne.isPending}
                        aria-label={
                          person.invitedAt ? t("resendInvitation") : t("sendInvitation")
                        }
                        title={
                          person.invitedAt ? t("resendInvitation") : t("sendInvitation")
                        }
                      >
                        <Mail />
                      </Button>
                    ) : null}
                    {person.role === "STUDENT" ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          setNewGuardianId("");
                          setGuardiansFor(person);
                        }}
                        aria-label={t("manageGuardians")}
                        title={t("manageGuardians")}
                      >
                        <Link2 />
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openEdit(person)}
                      aria-label={tCommon("edit")}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDeleting(person)}
                      aria-label={tCommon("delete")}
                    >
                      <Trash2 className="text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
                {expandedId === person.id ? (
                  <TableRow id={`person-detail-${person.id}`} className="bg-muted/30">
                    <TableCell colSpan={7} className="py-3">
                      <PersonDetail
                        person={person}
                        homeClass={groupName(person.studentGroupId)}
                        teachingGroups={teachingGroupsOf(
                          person.id,
                          groups ?? [],
                          memberships ?? [],
                        )}
                        taught={taughtGroupsOf(
                          person.id,
                          requirements ?? [],
                          groups ?? [],
                        )}
                        subjectName={subjectName}
                        t={t}
                      />
                    </TableCell>
                  </TableRow>
                ) : null}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? t("editPerson") : t("addPerson")}</DialogTitle>
            {!editing ? <DialogDescription>{t("authHint")}</DialogDescription> : null}
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="person-first">{t("firstName")}</Label>
                <Input
                  id="person-first"
                  value={form.firstName}
                  onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="person-last">{t("lastName")}</Label>
                <Input
                  id="person-last"
                  value={form.lastName}
                  onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="person-email">{t("email")}</Label>
              <Input
                id="person-email"
                type="email"
                value={form.email}
                disabled={editing !== null}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="person-phone">
                  {t("phone")}{" "}
                  <span className="text-muted-foreground">({tCommon("optional")})</span>
                </Label>
                <Input
                  id="person-phone"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>{t("role")}</Label>
                <Select
                  value={form.role}
                  onValueChange={(value) => setForm({ ...form, role: value as UserRole })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.map((role) => (
                      <SelectItem key={role} value={role}>
                        {tRoles(role)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {form.role === "STUDENT" ? (
              <div className="space-y-2">
                <Label>{t("class")}</Label>
                <Select
                  value={form.studentGroupId}
                  onValueChange={(value) => setForm({ ...form, studentGroupId: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_GROUP}>{tCommon("none")}</SelectItem>
                    {(groups ?? []).map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        {group.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {!editing ? (
              <div className="flex items-start justify-between gap-4 rounded-md border p-3">
                <div className="space-y-1">
                  <Label htmlFor="send-invitation">{t("sendInvitation")}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t("sendInvitationHelp")}
                  </p>
                </div>
                <Switch
                  id="send-invitation"
                  checked={sendInvitation}
                  onCheckedChange={setSendInvitation}
                />
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button
              onClick={submit}
              disabled={
                form.firstName.trim().length === 0 ||
                form.lastName.trim().length === 0 ||
                (!editing && form.email.trim().length === 0) ||
                mutations.create.isPending ||
                mutations.update.isPending
              }
            >
              {tCommon("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={guardiansFor !== null}
        onOpenChange={(open) => !open && setGuardiansFor(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("guardiansTitle", {
                name: guardiansFor
                  ? `${guardiansFor.firstName} ${guardiansFor.lastName}`
                  : "",
              })}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            {(studentGuardians ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("guardiansEmpty")}</p>
            ) : (
              (studentGuardians ?? []).map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <div className="font-medium">
                      {entry.guardian.firstName} {entry.guardian.lastName}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {entry.guardian.email}
                    </div>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => void guardianLinks.unlink.mutateAsync(entry.id)}
                    aria-label={tCommon("delete")}
                  >
                    <Trash2 className="text-destructive" />
                  </Button>
                </div>
              ))
            )}
          </div>
          <div className="flex gap-2">
            <Select value={newGuardianId || undefined} onValueChange={setNewGuardianId}>
              <SelectTrigger>
                <SelectValue placeholder={t("selectGuardian")} />
              </SelectTrigger>
              <SelectContent>
                {(people ?? [])
                  .filter(
                    (person) =>
                      person.role === "GUARDIAN" &&
                      !(studentGuardians ?? []).some(
                        (entry) => entry.guardianId === person.id,
                      ),
                  )
                  .map((person) => (
                    <SelectItem key={person.id} value={person.id}>
                      {person.firstName} {person.lastName}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Button
              onClick={() => {
                if (!guardiansFor || !newGuardianId) return;
                void guardianLinks.link
                  .mutateAsync({ guardianId: newGuardianId, studentId: guardiansFor.id })
                  .then(() => setNewGuardianId(""))
                  .catch((error: unknown) =>
                    toast.error(
                      error instanceof Error ? error.message : tCommon("error"),
                    ),
                  );
              }}
              disabled={!newGuardianId || guardianLinks.link.isPending}
            >
              {t("linkGuardian")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <CsvImportDialog
        kinds={["students", "teachers"]}
        open={importOpen}
        onOpenChange={setImportOpen}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={tCommon("deleteConfirmTitle", {
          name: deleting ? `${deleting.firstName} ${deleting.lastName}` : "",
        })}
        description={tCommon("deleteConfirmBody")}
        confirmLabel={tCommon("delete")}
        loading={mutations.remove.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
