"use client";

import { useTranslations } from "next-intl";
import { FileText } from "lucide-react";
import { useProfile } from "@/components/profile-context";
import { formatStamp } from "@/lib/employment-history-view";
import { Uppdragsbeskrivning } from "@/components/staffing/uppdragsbeskrivning";
import { UppdragsbeskrivningPage } from "@/components/staffing/uppdrag-page";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { useAdminUppdragsbeskrivning } from "./use-uppdragsbeskrivning";

/** The admin's printable uppdragsbeskrivning for one teacher; see page.tsx. */
export function AdminUppdragsbeskrivning({
  teacherId,
  yearId,
}: {
  teacherId: string | null;
  yearId: string | null;
}) {
  const t = useTranslations("uppdrag");
  const { school } = useProfile();
  const timeZone = school?.timezone ?? "Europe/Stockholm";
  const data = useAdminUppdragsbeskrivning(teacherId, yearId);
  // Back to the drawer's page, on the year the paper was opened for.
  const back = {
    href: yearId ? `/admin/staffing?year=${encodeURIComponent(yearId)}` : "/admin/staffing",
    label: t("backAdmin"),
  };
  const noTeacher = (
    <EmptyState icon={FileText} title={t("noTeacher")} description={t("noTeacherHint")} headingLevel={2} />
  );

  if (!teacherId || !yearId) {
    return <UppdragsbeskrivningPage back={back}>{noTeacher}</UppdragsbeskrivningPage>;
  }
  if (data.isLoading) {
    return (
      <UppdragsbeskrivningPage back={back}>
        <Skeleton className="h-96 w-full" aria-busy="true" />
      </UppdragsbeskrivningPage>
    );
  }
  if (data.isError) {
    return (
      <UppdragsbeskrivningPage back={back}>
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      </UppdragsbeskrivningPage>
    );
  }
  if (!data.row || !data.yearName) {
    return <UppdragsbeskrivningPage back={back}>{noTeacher}</UppdragsbeskrivningPage>;
  }
  return (
    <UppdragsbeskrivningPage back={back} document>
      <Uppdragsbeskrivning
        yearName={data.yearName}
        schoolName={school?.name ?? ""}
        teacherName={data.teacherName ?? "—"}
        load={data.row}
        loadModel={data.loadModel}
        travel={data.travel}
        duties={data.duties}
        subjectName={data.subjectName}
        groupName={data.groupName}
        version={data.version}
        timeZone={timeZone}
        printedOn={formatStamp(new Date().toISOString(), timeZone).slice(0, 10)}
      />
    </UppdragsbeskrivningPage>
  );
}
