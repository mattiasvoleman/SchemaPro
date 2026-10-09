"use client";

import { useTranslations } from "next-intl";
import { FileText, TriangleAlert } from "lucide-react";
import { useProfile } from "@/components/profile-context";
import { formatStamp } from "@/lib/employment-history-view";
import { Uppdragsbeskrivning } from "@/components/staffing/uppdragsbeskrivning";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useMyUppdragsbeskrivning } from "./use-my-uppdragsbeskrivning";

/** The teacher's own printable uppdragsbeskrivning; see page.tsx. */
export function MyUppdragsbeskrivning({ yearId }: { yearId: string | null }) {
  const t = useTranslations("uppdrag");
  const { profile, school } = useProfile();
  const timeZone = school?.timezone ?? "Europe/Stockholm";
  const data = useMyUppdragsbeskrivning(profile.id, yearId);

  if (data.isLoading) return <Skeleton className="mx-auto h-96 w-full max-w-3xl" />;
  if (data.isError) return <EmptyState icon={TriangleAlert} title={t("loadFailed")} />;
  if (!data.row || !data.yearName) {
    return <EmptyState icon={FileText} title={t("noOwnPost")} description={t("noOwnPostHint")} />;
  }
  return (
    <Uppdragsbeskrivning
      yearName={data.yearName}
      schoolName={school?.name ?? ""}
      teacherName={`${profile.firstName} ${profile.lastName}`}
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
