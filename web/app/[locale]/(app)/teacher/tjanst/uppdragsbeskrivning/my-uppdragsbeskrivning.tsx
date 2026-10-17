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
import { useMyUppdragsbeskrivning } from "./use-my-uppdragsbeskrivning";

/** The teacher's own printable uppdragsbeskrivning; see page.tsx. */
export function MyUppdragsbeskrivning({ yearId }: { yearId: string | null }) {
  const t = useTranslations("uppdrag");
  const { profile, school } = useProfile();
  const timeZone = school?.timezone ?? "Europe/Stockholm";
  const data = useMyUppdragsbeskrivning(profile.id, yearId);
  const back = { href: "/teacher/tjanst", label: t("backTeacher") };

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
    return (
      <UppdragsbeskrivningPage back={back}>
        <EmptyState icon={FileText} title={t("noOwnPost")} description={t("noOwnPostHint")} headingLevel={2} />
      </UppdragsbeskrivningPage>
    );
  }
  return (
    <UppdragsbeskrivningPage back={back} document>
      <Uppdragsbeskrivning
        yearName={data.yearName}
        schoolName={school?.name ?? ""}
        teacherName={`${profile.firstName} ${profile.lastName}`}
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
