"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";

/**
 * "Visa i veckan" under a refusal's sentence, for a refusal that names a förläggning with the ids the link is built from. Its name
 * says which line it is about: a probe can list a hundred of them, and a link that only says "Visa i veckan" is a hundred of the same.
 */
export function RefusalLink({ href, sentence }: { href: string | null; sentence: string }) {
  const t = useTranslations("generate.placed");
  if (href === null) return null;
  return (
    <p>
      <Link href={href} aria-label={t("refusalLinkLabel", { sentence })} className="font-medium underline underline-offset-4">
        {t("refusalLink")}
      </Link>
    </p>
  );
}
