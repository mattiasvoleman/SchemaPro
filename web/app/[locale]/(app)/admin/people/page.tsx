"use client";

import { Fragment, Suspense, lazy, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  ChevronRight,
  Clock,
  Link2,
  Mail,
  Pencil,
  Plus,
  Trash2,
  Unlink,
  Upload,
  UserCheck,
} from "lucide-react";
import { LazyCsvImportDialog } from "@/components/import/lazy-csv-import-dialog";
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
import { studentsToCsv, teacherQualificationsToCsv, teachersToCsv } from "@/lib/csv-export";
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
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { filterByQuery } from "@/lib/search";
import { homeClassOptions } from "@/lib/year-scope";
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
import { FilterBar } from "@/components/ui/filter-bar";
import { FormField } from "@/components/ui/form-field";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { RowActions, type RowAction } from "@/components/ui/row-actions";
import { SearchField } from "@/components/ui/search-field";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCard } from "@/components/ui/table-card";
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
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const ROLES: UserRole[] = ["STUDENT", "TEACHER", "SCHOOL_ADMIN", "GUARDIAN"];
const NO_GROUP = "__none__";
/** The register's columns; the detail row spans them all. */
const COLUMNS = 7;
/**
 * Every action a row can have — edit, guardians or working time, the
 * invitation, delete — as an icon, none behind "Fler åtgärder". Four, the
 * most any row has; the Åtgärder column is w-40 to hold them.
 */
const PEOPLE_INLINE_ACTIONS = 4;

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
          <section aria-labelledby={`person-staffing-${person.id}`} className="space-y-3">
            {/*
              The year the cards write into, said once above them: the post
              and the uppdrag are per läsår, and the page has no year picker
              of its own — the register is the school's people, not a year's.
              Also the h2 the cards' own h3 headings sit under.
            */}
            <h2 id={`person-staffing-${person.id}`} className="text-base font-semibold">
              {t("staffingYear", { year: staffing.academicYearName })}
            </h2>
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
          </section>
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
  const { data: people, isLoading, isError } = usePeople();
  const groupsQuery = useGroups();
  const groups = groupsQuery.data;
  const membershipsQuery = useGroupMemberships();
  const memberships = membershipsQuery.data;
  const subjectsQuery = useSubjects();
  const subjects = subjectsQuery.data;
  const yearsQuery = useAcademicYears();
  const years = yearsQuery.data;
  const activeYear = years?.find((year) => year.isActive) ?? years?.[0] ?? null;
  const activeYearId = activeYear?.id ?? null;
  const requirementsQuery = useRequirements(activeYearId);
  const requirements = requirementsQuery.data;
  /**
   * The staff's posts for the active year, their behörigheter and the policy
   * that turns a post into a target — read once for the whole list, like the
   * working-time rules, and looked up per row.
   */
  const employmentsQuery = useTeacherEmployments(activeYearId);
  const employments = employmentsQuery.data;
  const qualificationsQuery = useTeacherQualifications();
  const qualifications = qualificationsQuery.data;
  const policyQuery = useStaffingPolicy();
  const policy = policyQuery.data;
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
  const workRulesQuery = useTeacherWorkRules();
  const workRules = workRulesQuery.data;
  /*
   * The register itself is usePeople; everything a row says beyond the name
   * — the class, the groups, what a teacher teaches, the post, the working
   * time — comes from reads of its own. When one of those fails the row
   * would read "—" or "nothing" as if that were the answer, so the page says
   * once, above the table, that some of it could not be read.
   */
  const detailsFailed = [
    groupsQuery,
    membershipsQuery,
    subjectsQuery,
    yearsQuery,
    requirementsQuery,
    employmentsQuery,
    qualificationsQuery,
    // The policy turns a post into the target the Anställning card shows.
    policyQuery,
    workRulesQuery,
  ].some((query) => query.isError);
  const workRuleOf = (teacherId: string) =>
    workRules?.find((rule) => rule.userId === teacherId);
  const [workTimeFor, setWorkTimeFor] = useState<Person | null>(null);
  const [guardiansFor, setGuardiansFor] = useState<Person | null>(null);
  // ?guardians=<pupil id> opens that pupil's guardians, once: the link the
  // SS12000 diff review gives for a guardian the register no longer names
  // (a sync never unlinks one; the admin does it here). Read after mount, as
  // the staffing page reads ?year=, not with useSearchParams.
  const [linkedPupilId, setLinkedPupilId] = useState<string | null>(null);
  useEffect(() => setLinkedPupilId(new URLSearchParams(window.location.search).get("guardians")), []);
  useEffect(() => {
    if (!linkedPupilId || !people) return;
    const pupil = people.find((person) => person.id === linkedPupilId && person.role === "STUDENT");
    if (pupil) setGuardiansFor(pupil);
    setLinkedPupilId(null);
  }, [linkedPupilId, people]);
  const guardiansQuery = useStudentGuardians(guardiansFor?.id ?? null);
  const studentGuardians = guardiansQuery.data;
  const guardianLinks = useGuardianLinkActions();
  const [newGuardianId, setNewGuardianId] = useState("");
  /** The guardian link a click asked to remove, held until the admin confirms it. */
  const [unlinking, setUnlinking] = useState<{ id: string; name: string } | null>(null);
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
  /**
   * The home classes the form offers: the active year's classes, plus the
   * class the pupil is in now when that is elsewhere, named with its year.
   * Every year's groups would list each name twice between a rollover and
   * its activation — next year's 8A beside this year's — and a click on the
   * wrong one puts the pupil in the wrong cohort (lib/year-scope.ts).
   */
  const homeClasses = useMemo(
    () => homeClassOptions(groups, years, activeYearId, editing?.studentGroupId ?? null),
    [groups, years, activeYearId, editing],
  );
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

  /*
   * A guardian taken off a pupil stops seeing the pupil's week and can no
   * longer report the pupil sick, so the click asks first, as every other
   * removal on this page does — and a refusal says so instead of vanishing.
   */
  const confirmUnlink = async () => {
    if (!unlinking) return;
    try {
      await guardianLinks.unlink.mutateAsync(unlinking.id);
      toast.success(t("guardianUnlinked", { name: unlinking.name }));
      setUnlinking(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  /**
   * A row's actions in order of use: edit first, then what only that role
   * has (guardians, working time), then the invitation, then delete last.
   * All of them stay icons on the row (PEOPLE_INLINE_ACTIONS): a row has at
   * most four, as before the 2026-10-11 overhaul, and the manual sends the
   * reader to the envelope on the row to invite one person.
   */
  const actionsOf = (person: Person): RowAction[] => {
    const name = `${person.firstName} ${person.lastName}`;
    const actions: RowAction[] = [
      {
        label: tCommon("edit"),
        icon: Pencil,
        ariaLabel: tCommon("editNamed", { name }),
        onSelect: () => openEdit(person),
      },
    ];
    if (person.role === "STUDENT") {
      actions.push({
        label: t("manageGuardians"),
        icon: Link2,
        ariaLabel: t("guardiansTitle", { name }),
        onSelect: () => {
          setNewGuardianId("");
          setGuardiansFor(person);
        },
      });
    }
    // Only on a member of staff's row, the way the guardian link is only on
    // a student's: see MAY_HAVE_WORK_TIME for why the undervisande rektor
    // counts and a pupil does not.
    if (MAY_HAVE_WORK_TIME.includes(person.role)) {
      actions.push({
        label: t("workTimeLabel"),
        icon: Clock,
        ariaLabel: tWorkTime("editFor", { name }),
        onSelect: () => setWorkTimeFor(person),
      });
    }
    if (person.isActive) {
      actions.push({
        label: person.invitedAt ? t("resendInvitation") : t("sendInvitation"),
        icon: Mail,
        ariaLabel: person.invitedAt
          ? t("resendInvitationTo", { name })
          : t("sendInvitationTo", { name }),
        onSelect: () => void inviteOne(person),
        disabled: invitations.inviteOne.isPending,
      });
    }
    actions.push({
      label: tCommon("delete"),
      icon: Trash2,
      ariaLabel: tCommon("deleteNamed", { name }),
      onSelect: () => setDeleting(person),
    });
    return actions;
  };

  return (
    <Page>
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
                <Mail aria-hidden="true" />
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
              <Upload aria-hidden="true" />
              {tCsvImport("button")}
            </Button>
            <Button onClick={openCreate}>
              <Plus aria-hidden="true" />
              {t("addPerson")}
            </Button>
          </>
        }
      />

      <FilterBar>
        <Tabs value={filter} onValueChange={(value) => setFilter(value as "ALL" | UserRole)}>
          {/* Five roles do not fit a 390 px phone in one row (418 px): the
              pill wraps rather than widen the page into a sideways scroll. */}
          <TabsList aria-label={t("role")} className="h-auto flex-wrap justify-start">
            <TabsTrigger value="ALL">{t("filterAll")}</TabsTrigger>
            {ROLES.map((role) => (
              <TabsTrigger key={role} value={role}>
                {tRoles(role)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <SearchField
          id="people-search"
          label={t("searchLabel")}
          value={search}
          onValueChange={setSearch}
        />
      </FilterBar>

      {isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : isError ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : !people || people.length === 0 ? (
        <EmptyState
          icon={UserCheck}
          title={t("emptyTitle")}
          description={t("emptyHint")}
          headingLevel={2}
          action={
            <Button onClick={openCreate}>
              <Plus aria-hidden="true" />
              {t("addPerson")}
            </Button>
          }
        />
      ) : (
        <>
          {detailsFailed ? (
            <LoadError variant="inline" title={t("detailsFailed")} hint={t("detailsFailedHint")} />
          ) : null}
          <TableCard caption={t("tableCaption")}>
            <TableHeader>
              <TableRow>
                <TableHead>{tCommon("name")}</TableHead>
                <TableHead>{t("email")}</TableHead>
                <TableHead>{t("role")}</TableHead>
                <TableHead>{t("class")}</TableHead>
                <TableHead>{tCommon("status")}</TableHead>
                <TableHead>{t("invitationState")}</TableHead>
                <TableHead className="w-40 text-right">{tCommon("actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                // A search or a role tab that matches nobody is a miss, not a
                // school without people: said in the table, under the filters
                // that caused it.
                <TableRow>
                  <TableCell colSpan={COLUMNS} className="py-8 text-center text-muted-foreground">
                    {t("noMatch")}
                  </TableCell>
                </TableRow>
              ) : null}
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
                      className="flex items-center gap-1.5 rounded-sm text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ChevronRight
                        aria-hidden="true"
                        className={
                          expandedId === person.id
                            ? "size-3.5 rotate-90 transition-transform"
                            : "size-3.5 transition-transform"
                        }
                      />
                      {person.firstName} {person.lastName}
                    </button>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{person.email}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{tRoles(person.role)}</Badge>
                  </TableCell>
                  <TableCell>
                    {person.studentGroupId ? (
                      groupName(person.studentGroupId)
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
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
                    <RowActions
                      name={`${person.firstName} ${person.lastName}`}
                      actions={actionsOf(person)}
                      inlineMax={PEOPLE_INLINE_ACTIONS}
                    />
                  </TableCell>
                </TableRow>
                {expandedId === person.id ? (
                  <TableRow id={`person-detail-${person.id}`} className="bg-muted/40 hover:bg-muted/40">
                    <TableCell colSpan={COLUMNS} className="py-3">
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
          </TableCard>
        </>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? t("editPerson") : t("addPerson")}</DialogTitle>
            <DialogDescription>{editing ? t("editHint") : t("authHint")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
              <FormField id="person-first" label={t("firstName")}>
                <Input
                  value={form.firstName}
                  onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                />
              </FormField>
              <FormField id="person-last" label={t("lastName")}>
                <Input
                  value={form.lastName}
                  onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                />
              </FormField>
            </div>
            <FormField id="person-email" label={t("email")}>
              <Input
                type="email"
                value={form.email}
                disabled={editing !== null}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
              <FormField id="person-phone" label={t("phone")} optional>
                <Input
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                />
              </FormField>
              <FormField id="person-role" label={t("role")}>
                {(control) => (
                  <Select
                    value={form.role}
                    onValueChange={(value) => setForm({ ...form, role: value as UserRole })}
                  >
                    <SelectTrigger {...control}>
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
                )}
              </FormField>
            </div>
            {form.role === "STUDENT" ? (
              <FormField id="person-class" label={t("class")}>
                {(control) => (
                  <Select
                    value={form.studentGroupId}
                    onValueChange={(value) => setForm({ ...form, studentGroupId: value })}
                  >
                    <SelectTrigger {...control}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_GROUP}>{tCommon("none")}</SelectItem>
                      {homeClasses.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </FormField>
            ) : null}

            {showsPost ? (
              <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
                <FormField
                  id="person-employment"
                  label={tStaffing("employmentPercent")}
                  optional
                  hint={tStaffing("employmentHint", { year: activeYear?.name ?? "" })}
                >
                  <Input
                    inputMode="decimal"
                    value={form.employmentPercent}
                    onChange={(e) => setForm({ ...form, employmentPercent: e.target.value })}
                  />
                </FormField>
                <FormField
                  id="person-signature"
                  label={tStaffing("signature")}
                  optional
                  hint={tStaffing("signatureHint")}
                >
                  <Input
                    maxLength={8}
                    value={form.signature}
                    onChange={(e) => setForm({ ...form, signature: e.target.value })}
                  />
                </FormField>
                {postProblem ? (
                  <Notice tone="destructive" className="sm:col-span-2">
                    {postProblemText(postProblem)}
                  </Notice>
                ) : null}
              </div>
            ) : null}

            {!editing ? (
              <div className="flex items-start justify-between gap-4 rounded-md border p-3">
                <div className="space-y-1">
                  <Label htmlFor="send-invitation">{t("sendInvitation")}</Label>
                  <p id="send-invitation-hint" className="text-xs text-muted-foreground">
                    {t("sendInvitationHelp")}
                  </p>
                </div>
                <Switch
                  id="send-invitation"
                  checked={sendInvitation}
                  onCheckedChange={setSendInvitation}
                  aria-describedby="send-invitation-hint"
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("guardiansTitle", {
                name: guardiansFor
                  ? `${guardiansFor.firstName} ${guardiansFor.lastName}`
                  : "",
              })}
            </DialogTitle>
            <DialogDescription>{t("guardiansHint")}</DialogDescription>
          </DialogHeader>
          {/* "Inga vårdnadshavare" only once the links have been read: while
              they load, or when the read failed, the pupil may well have some. */}
          {guardiansQuery.isLoading ? (
            <div aria-busy="true">
              <Skeleton className="h-16 w-full" />
            </div>
          ) : guardiansQuery.isError ? (
            <LoadError
              variant="inline"
              title={t("guardiansLoadFailed")}
              hint={t("guardiansLoadFailedHint")}
            />
          ) : (studentGuardians ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("guardiansEmpty")}</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {(studentGuardians ?? []).map((entry) => {
                const name = `${entry.guardian.firstName} ${entry.guardian.lastName}`;
                return (
                  <li key={entry.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                    <div className="min-w-0">
                      <div className="font-medium">{name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {entry.guardian.email}
                      </div>
                    </div>
                    <RowActions
                      name={name}
                      actions={[
                        {
                          label: t("unlinkConfirm"),
                          icon: Unlink,
                          ariaLabel: t("unlinkGuardian", { name }),
                          onSelect: () => setUnlinking({ id: entry.id, name }),
                        },
                      ]}
                    />
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex items-end gap-2">
            <FormField id="person-add-guardian" label={t("addGuardianLabel")} className="min-w-0 flex-1">
              {(control) => (
                <Select value={newGuardianId || undefined} onValueChange={setNewGuardianId}>
                  <SelectTrigger {...control}>
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
              )}
            </FormField>
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

      <LazyCsvImportDialog
        kinds={["students", "teachers", "teacherQualifications", "teacherDuties"]}
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

      <ConfirmDialog
        open={unlinking !== null}
        onOpenChange={(open) => !open && setUnlinking(null)}
        title={t("unlinkTitle", { guardian: unlinking?.name ?? "" })}
        description={t("unlinkBody", {
          guardian: unlinking?.name ?? "",
          pupil: guardiansFor ? `${guardiansFor.firstName} ${guardiansFor.lastName}` : "",
        })}
        confirmLabel={t("unlinkConfirm")}
        loading={guardianLinks.unlink.isPending}
        onConfirm={() => void confirmUnlink()}
      />
    </Page>
  );
}
