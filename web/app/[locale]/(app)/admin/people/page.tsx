"use client";

import { Fragment, Suspense, lazy, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  ChevronRight,
  Clock,
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
import {
  TeacherWorkTimeDialog,
  TeacherWorkTimeSummary,
} from "@/components/schedule/teacher-work-time-dialog";
/*
 * Fetched when a staff row is opened, not when the register loads.
 *
 * The two cards are 680 lines between them — a post editor and a behörighet
 * editor that carries the date picker, and lib/teacher-load behind it — and
 * they draw nothing until an admin expands one member of staff. Imported
 * statically they were the largest part of what took this route's own
 * initial JS from 181.7KB to 191.9KB gzipped, past the 190KB admin budget.
 * The same reasoning the timetable page applies to its room-optimisation
 * dialog; the working-time summary every staff row shows stays imported
 * normally.
 *
 * React's own lazy(), not next/dynamic: next/dynamic brings its loader
 * runtime (BailoutToCSR, PreloadChunks, loadable) into the route, measured
 * at 1.4KB gzipped — on this page the difference between 187.5KB and
 * 186.2KB own JS (2026-10-06). React is in every route already, so lazy()
 * costs nothing on top. Nothing lazy is reachable during SSR: every row
 * starts collapsed, so the first render never asks for either module — the
 * condition the timetable page relies on as well.
 */
const EmploymentCard = lazy(() =>
  import("@/components/staffing/employment-card").then((module) => ({
    default: module.EmploymentCard,
  })),
);
const QualificationsCard = lazy(() =>
  import("@/components/staffing/qualifications-card").then((module) => ({
    default: module.QualificationsCard,
  })),
);
/** Fas 2's third card, lazy for the same reason and on the same condition. */
const DutiesCard = lazy(() =>
  import("@/components/staffing/duties-card").then((module) => ({
    default: module.DutiesCard,
  })),
);
import { studentsToCsv, teacherQualificationsToCsv, teachersToCsv } from "@/lib/csv";
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
  useTeacherWorkRules,
} from "@/lib/queries";
import {
  useStaffingPolicy,
  useTeacherEmploymentActions,
  useTeacherEmployments,
  useTeacherQualifications,
} from "@/lib/staffing-queries";
import {
  employmentDraftToBody,
  employmentToDraft,
  validateEmploymentDraft,
  type EmploymentProblem,
} from "@/lib/staffing-forms";
import type {
  Person,
  StaffingPolicy,
  StudentGroup,
  Subject,
  TeacherEmployment,
  TeacherQualification,
  TeacherWorkRule,
  UserRole,
} from "@/lib/types";
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

/**
 * Who a working-time rule can belong to.
 *
 * STAFF, not TEACHER alone. An undervisande rektor carries SCHOOL_ADMIN in this
 * schema and the timplan names her as freely as anybody else, so she has a last
 * lesson for a night to follow and a day for a lunch to sit in — and the
 * gateway's assertIsStaff admits her for exactly that reason. Offering the rule
 * to TEACHER only would leave her the one member of staff who cannot be given
 * one, through the UI, over a rule the API and the database both accept.
 *
 * A pupil and a guardian teach nothing, so there is no rule to write and no
 * button to draw.
 */
const MAY_HAVE_WORK_TIME: UserRole[] = ["TEACHER", "SCHOOL_ADMIN"];

interface PersonForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  role: UserRole;
  studentGroupId: string;
  /**
   * The quick half of a teacher's post — tjänst and signatur — for the active
   * läsår. Strings, like every number in a dialog: "" means "say nothing about
   * the post", which leaves a stored one untouched and writes none for a new
   * teacher. The full post (nedsättning, avtal, eget riktmärke) is edited on
   * the Anställning card in the row below.
   */
  employmentPercent: string;
  signature: string;
}

const EMPTY_FORM: PersonForm = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  role: "STUDENT",
  studentGroupId: NO_GROUP,
  employmentPercent: "",
  signature: "",
};

/**
 * What the two staffing cards on a staff row need, gathered once by the page.
 * Null while the school has no läsår: a post is per year, so there is nothing
 * to write it into.
 */
interface StaffingContext {
  academicYearId: string;
  academicYearName: string;
  /** The läsår's groups, for an uppdrag's mentorskap class. */
  groups: { id: string; name: string }[];
  employment: TeacherEmployment | null;
  qualifications: TeacherQualification[] | undefined;
  policy: StaffingPolicy | null | undefined;
  subjects: Subject[];
}

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
  workRule,
  staffing,
  subjectName,
  t,
}: {
  person: Person;
  homeClass: string;
  teachingGroups: StudentGroup[];
  taught: TaughtGroup[];
  /** Their stored working time, or undefined when they have none. */
  workRule: TeacherWorkRule | undefined;
  /** The post and behörigheter, for a member of staff with a läsår to hold them. */
  staffing: StaffingContext | null;
  subjectName: (id: string) => string;
  t: (key: string, values?: Record<string, string | number>) => string;
}) {
  if (person.role !== "STUDENT") {
    return (
      <div className="space-y-3">
        {person.role === "TEACHER" ? (
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
        ) : (
          <p className="text-sm text-muted-foreground">{t("noGroupInfo")}</p>
        )}
        {/*
          Here rather than in a column of its own, for the reason the raster page
          gives about its lesson-before flag: an eighth column would be blank on
          every student and guardian row, and it would cost width the e-post and
          the invitation state need more. The person's own row is already where
          this app answers questions that are about one member of staff.
        */}
        {MAY_HAVE_WORK_TIME.includes(person.role) ? (
          <div className="space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("workTimeLabel")}
            </p>
            <TeacherWorkTimeSummary rule={workRule} />
          </div>
        ) : null}
        {/*
          The same cards the staffing drawer shows, because they are about
          the same person and the same rows: an admin adding a new teacher in
          August fills the post here without leaving the register, and the
          matrix reads it the next time it is opened. Staff roles, as for the
          working time — the gateway admits a SCHOOL_ADMIN's post for the same
          undervisande rektor.
        */}
        {MAY_HAVE_WORK_TIME.includes(person.role) && staffing ? (
          <div className="grid gap-3 lg:grid-cols-2">
            <Suspense fallback={<Skeleton className="h-32 w-full" />}>
              <EmploymentCard
                teacher={person}
                academicYearId={staffing.academicYearId}
                academicYearName={staffing.academicYearName}
                employment={staffing.employment}
                policy={staffing.policy}
              />
            </Suspense>
            <Suspense fallback={<Skeleton className="h-32 w-full" />}>
              <QualificationsCard
                teacher={person}
                qualifications={staffing.qualifications}
                subjects={staffing.subjects}
              />
            </Suspense>
            <Suspense fallback={<Skeleton className="h-32 w-full" />}>
              <DutiesCard
                teacher={person}
                academicYearId={staffing.academicYearId}
                academicYearName={staffing.academicYearName}
                subjects={staffing.subjects}
                groups={staffing.groups}
              />
            </Suspense>
          </div>
        ) : null}
      </div>
    );
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
  const tWorkTime = useTranslations("teacherWorkTime");
  const tStaffing = useTranslations("staffing");
  const tCommon = useTranslations("common");
  const tRoles = useTranslations("roles");
  const tCsvImport = useTranslations("csvImport");
  const { data: people, isLoading } = usePeople();
  const { data: groups } = useGroups();
  const { data: memberships } = useGroupMemberships();
  const { data: subjects } = useSubjects();
  const { data: years } = useAcademicYears();
  const activeYear = years?.find((year) => year.isActive) ?? years?.[0] ?? null;
  const activeYearId = activeYear?.id ?? null;
  const { data: requirements } = useRequirements(activeYearId);
  /**
   * The staff's posts for the active year, their behörigheter and the policy
   * that turns a post into a target — read once for the whole list, like the
   * working-time rules, and looked up per row.
   */
  const { data: employments } = useTeacherEmployments(activeYearId);
  const { data: qualifications } = useTeacherQualifications();
  const { data: policy } = useStaffingPolicy();
  const employmentActions = useTeacherEmploymentActions();
  const employmentOf = (userId: string) =>
    employments?.find((row) => row.userId === userId) ?? null;
  const staffingFor = (person: Person): StaffingContext | null =>
    activeYear
      ? {
          academicYearId: activeYear.id,
          academicYearName: activeYear.name,
          groups: (groups ?? []).filter((group) => group.academicYearId === activeYear.id),
          employment: employmentOf(person.id),
          qualifications: qualifications?.filter((row) => row.userId === person.id),
          policy,
          subjects: subjects ?? [],
        }
      : null;
  /**
   * The staff's working-time rules, read once for the whole list.
   *
   * At most one row per person and no row for most of them, so this is a lookup
   * by userId rather than an index — see useTeacherWorkRules.
   */
  const { data: workRules } = useTeacherWorkRules();
  const workRuleOf = (teacherId: string) =>
    workRules?.find((rule) => rule.userId === teacherId);
  const [workTimeFor, setWorkTimeFor] = useState<Person | null>(null);
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
    const post = employmentOf(person.id);
    setForm({
      firstName: person.firstName,
      lastName: person.lastName,
      email: person.email,
      phone: person.phone ?? "",
      role: person.role,
      studentGroupId: person.studentGroupId ?? NO_GROUP,
      employmentPercent: post ? String(post.employmentPercent) : "",
      signature: post?.signature ?? "",
    });
    setDialogOpen(true);
  };

  /** Whether the dialog shows the two post fields: a member of staff, and a year to write into. */
  const showsPost = MAY_HAVE_WORK_TIME.includes(form.role) && activeYearId !== null;

  /**
   * The post the dialog would write: the stored row with the two fields
   * replaced, or a fresh one from them. Built on the stored draft so a
   * nedsättning or an own riktmärke set on the card survives a name change
   * here — PUT replaces the row whole.
   */
  const postDraft = () => ({
    ...employmentToDraft(editing ? employmentOf(editing.id) : null),
    employmentPercent: form.employmentPercent,
    signature: form.signature,
  });
  const postProblem: EmploymentProblem | null =
    showsPost && form.employmentPercent.trim() !== "" ? validateEmploymentDraft(postDraft()) : null;
  const postProblemText = (p: EmploymentProblem) => {
    const { reason, ...values } = p;
    return tStaffing(`problem_${reason}`, values as Record<string, number>);
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
      let userId = editing?.id ?? null;
      if (editing) {
        await mutations.update.mutateAsync({ id: editing.id, ...body });
        toast.success(tCommon("updated"));
      } else {
        const created = (await mutations.create.mutateAsync({
          ...body,
          email: form.email.trim(),
          sendInvitation,
        })) as { id?: string } | undefined;
        userId = created?.id ?? null;
        toast.success(sendInvitation ? t("createdAndInvited") : tCommon("created"));
      }
      /*
       * The post, written only when the dialog SAYS something about it. An
       * empty tjänst leaves a stored post alone rather than deleting it —
       * the card is where a post is taken away, with its own button — and
       * an unchanged pair sends nothing, so editing a phone number does not
       * rewrite HR data.
       */
      if (showsPost && userId && activeYearId && form.employmentPercent.trim() !== "") {
        const stored = editing ? employmentOf(editing.id) : null;
        const next = employmentDraftToBody(postDraft());
        const unchanged =
          stored !== null &&
          stored.employmentPercent === next.employmentPercent &&
          (stored.signature ?? null) === next.signature;
        if (!unchanged) {
          await employmentActions.save.mutateAsync({ userId, academicYearId: activeYearId, ...next });
        }
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
                  // With the active year's posts, so the file imports back
                  // with the tjänst it showed; a teacher without one gets
                  // empty post cells, which the importer leaves alone.
                  build: () =>
                    teachersToCsv(people ?? [], (userId) => employmentOf(userId) ?? undefined),
                  empty: !people?.some((person) => person.role === "TEACHER"),
                },
                {
                  kind: "teacherQualifications",
                  build: () =>
                    teacherQualificationsToCsv(qualifications ?? [], people ?? [], subjects ?? []),
                  empty: (qualifications ?? []).length === 0,
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
                    {/*
                      Only on a member of staff's row, the way the guardian link
                      is only on a student's: see MAY_HAVE_WORK_TIME for why the
                      undervisande rektor counts and a pupil does not.
                    */}
                    {MAY_HAVE_WORK_TIME.includes(person.role) ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setWorkTimeFor(person)}
                        aria-label={tWorkTime("editFor", {
                          name: `${person.firstName} ${person.lastName}`,
                        })}
                        title={tWorkTime("editFor", {
                          name: `${person.firstName} ${person.lastName}`,
                        })}
                      >
                        <Clock />
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
                        workRule={workRuleOf(person.id)}
                        staffing={staffingFor(person)}
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

            {showsPost ? (
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="person-employment">
                    {tStaffing("employmentPercent")}{" "}
                    <span className="text-muted-foreground">({tCommon("optional")})</span>
                  </Label>
                  <Input
                    id="person-employment"
                    inputMode="decimal"
                    value={form.employmentPercent}
                    onChange={(e) => setForm({ ...form, employmentPercent: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    {tStaffing("employmentHint", { year: activeYear?.name ?? "" })}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="person-signature">
                    {tStaffing("signature")}{" "}
                    <span className="text-muted-foreground">({tCommon("optional")})</span>
                  </Label>
                  <Input
                    id="person-signature"
                    maxLength={8}
                    value={form.signature}
                    onChange={(e) => setForm({ ...form, signature: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">{tStaffing("signatureHint")}</p>
                </div>
                {postProblem ? (
                  <p role="alert" className="col-span-2 text-sm text-destructive">
                    {postProblemText(postProblem)}
                  </p>
                ) : null}
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
                postProblem !== null ||
                mutations.create.isPending ||
                mutations.update.isPending ||
                employmentActions.save.isPending
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

      {/*
        Mounted only while it is open, and KEYED BY THE TEACHER AND THEIR ROW.
        The dialog fills its draft once, at mount, so that a background refetch
        of the rules query cannot throw away half-typed input; the key is what
        makes the other direction work too — a row that arrives after the dialog
        was opened, or one replaced by a save, changes the key and the form is
        filled again from what is now stored.
      */}
      {workTimeFor ? (
        <TeacherWorkTimeDialog
          key={`${workTimeFor.id}:${workRuleOf(workTimeFor.id)?.id ?? "none"}`}
          open
          onOpenChange={(open) => !open && setWorkTimeFor(null)}
          teacher={workTimeFor}
          rule={workRuleOf(workTimeFor.id)}
        />
      ) : null}

      <CsvImportDialog
        kinds={["students", "teachers", "teacherQualifications"]}
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
