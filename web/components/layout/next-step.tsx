import { useTranslations } from "next-intl";
import { ArrowRight } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface NextStepProps {
  /** The next page in the workflow: /admin/requirements after /admin/timplan, and so on. */
  href: string;
  /** That page's name as the nav says it ("Timplansposter"); the link reads "Nästa steg: Timplansposter". */
  name: string;
  className?: string;
}

/**
 * The forward link along the manual's chain (Timplan → Timplansposter →
 * Tjänstefördelning → Tillgänglighet → Generera; Grundschema → Luckor →
 * Publicering). A ghost button, so it never competes with the page's primary
 * action: put it at the end of the page or in PageHeader's actions.
 *
 * Server-safe (next-intl's useTranslations works in a server component too).
 */
export function NextStep({ href, name, className }: NextStepProps) {
  const t = useTranslations("common");
  return (
    <Button variant="ghost" size="sm" asChild className={cn("print:hidden", className)}>
      <Link href={href}>
        {t("nextStep", { name })}
        <ArrowRight aria-hidden="true" />
      </Link>
    </Button>
  );
}
