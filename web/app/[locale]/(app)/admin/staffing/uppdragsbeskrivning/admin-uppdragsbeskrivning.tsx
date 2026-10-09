"use client";

import { useTranslations } from "next-intl";
import { FileText, TriangleAlert } from "lucide-react";
import { useProfile } from "@/components/profile-context";
import { formatStamp } from "@/lib/employment-history-view";
import { Uppdragsbeskrivning } from "@/components/staffing/uppdragsbeskrivning";
import { EmptyState } from "@/components/ui/empty-state";
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

  if (!teacherId || !yearId) {
    return <EmptyState icon={FileText} title={t("noTeacher")} description={t("noTeacherHint")} />;
  }
  if (data.isLoading) return <Skeleton className="mx-auto h-96 w-full max-w-3xl" />;
  if (data.isError) {
    return <EmptyState icon={TriangleAlert} title={t("loadFailed")} />;
  }
  if (!data.row || !data.yearName) {
    return <EmptyState icon={FileText} title={t("noTeacher")} description={t("noTeacherHint")} />;
  }
  return (
    <Uppdragsbeskrivning
      yearName={data.yearName}
      schoolName={school?.name ?? ""}
      teacherName={data.teacherName ?? "—"}
      load={data.row}
      loadModel={data.loadModel}
      duties={data.duties}
      subjectName={data.subjectName}
      groupName={data.groupName}
      version={data.version}
      timeZone={timeZone}
      printedOn={formatStamp(new Date().toISOString(), timeZone).slice(0, 10)}
    />
  );
}
