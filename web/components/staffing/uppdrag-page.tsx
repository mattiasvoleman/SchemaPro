"use client";

import { useTranslations } from "next-intl";
import { ArrowLeft } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { DocumentTitle } from "@/components/layout/document-title";
import { Page } from "@/components/layout/page";
import { PageHeader, type PageHeaderBack } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";

/**
 * The frame of both uppdragsbeskrivning routes (the admin's, from the
 * staffing drawer, and the teacher's own, from Min tjänst): the narrow page,
 * the tab's title, and a named way back that is never printed.
 *
 * Two shapes. While the paper is not there — loading, an error, no post —
 * the page has the app's own header, so it still has an h1 and the back link
 * sits above it as on every page. Once the paper is drawn it brings its own
 * h1 (the document's title, printed), so the frame adds only the back link
 * above it and keeps the print look as it was: no width cap and no extra
 * spacing on paper, where the link itself is hidden.
 */
export function UppdragsbeskrivningPage({
  back,
  document = false,
  children,
}: {
  back: PageHeaderBack;
  /** True when `children` is the Uppdragsbeskrivning itself, with its own h1. */
  document?: boolean;
  children: React.ReactNode;
}) {
  const t = useTranslations("uppdrag");
  if (!document) {
    return (
      <Page width="narrow">
        <PageHeader title={t("title")} back={back} />
        {children}
      </Page>
    );
  }
  return (
    <Page width="narrow" className="print:max-w-none print:space-y-0">
      <DocumentTitle title={t("title")} />
      <div className="print:hidden">
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href={back.href}>
            <ArrowLeft aria-hidden="true" />
            {back.label}
          </Link>
        </Button>
      </div>
      {children}
    </Page>
  );
}
