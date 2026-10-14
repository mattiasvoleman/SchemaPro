import type { Metadata } from "next";
import { CalendarRange } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { localePath } from "@/i18n/paths";
import { contactFromEnv, statement, TITLE, type Block, type Inline } from "./statement";

/**
 * The tillgänglighetsredogörelse, public: Digg's guidance is that nobody
 * should have to sign in to read it, so proxy.ts lets it through and it is
 * linked from the sign-in pages' footer and from the app's menu.
 *
 * Server-rendered with no client code of its own: plain <a> and localePath,
 * not next/link (whose router would be this page's only JavaScript, for two
 * links to places a full load serves as well) or @/i18n/navigation.
 *
 * The statement is Swedish on /en too (statement.ts says why), so the article
 * carries lang="sv" there and the English page says so above it.
 */

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("accessibilityStatement");
  return { title: t("title") };
}

const LINK = "font-medium text-primary underline underline-offset-4 hover:text-foreground";

function InlineText({ parts }: { parts: Inline[] }) {
  return parts.map((part, index) =>
    typeof part === "string" ? (
      part
    ) : (
      <a key={index} href={part.href} className={LINK}>
        {part.text}
      </a>
    ),
  );
}

function BlockView({ block }: { block: Block }) {
  if (block.kind === "p") {
    return (
      <p>
        <InlineText parts={block.content} />
      </p>
    );
  }
  return (
    <ul className="list-disc space-y-2 pl-6">
      {block.items.map((item, index) => (
        <li key={index}>
          <InlineText parts={item} />
        </li>
      ))}
    </ul>
  );
}

export default async function AccessibilityStatementPage() {
  const locale = await getLocale();
  const t = await getTranslations("accessibilityStatement");
  const tCommon = await getTranslations("common");
  // The deployment's contact details, read when the page is served.
  const { intro, sections } = statement(contactFromEnv());

  return (
    <div className="min-h-screen bg-muted/40 px-4 py-10">
      <div className="mx-auto max-w-3xl">
        <header className="mb-8 flex items-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-md">
            <CalendarRange className="h-5 w-5" aria-hidden="true" />
          </div>
          <a href={localePath(locale, "/")} className="text-lg font-semibold leading-tight hover:underline">
            {tCommon("appName")}
          </a>
        </header>

        <main className="rounded-xl border bg-card p-6 text-card-foreground shadow-sm sm:p-10">
          {locale === "sv" ? null : <p className="mb-6 text-sm text-muted-foreground">{t("languageNote")}</p>}
          <article lang="sv" className="space-y-4 text-sm leading-relaxed sm:text-base">
            <h1 className="text-2xl font-semibold tracking-tight">{TITLE}</h1>
            {intro.map((block, index) => (
              <BlockView key={index} block={block} />
            ))}
            {sections.map((section) => {
              const Heading = section.level === 2 ? "h2" : "h3";
              return (
                <section key={section.heading} className="space-y-3 pt-2">
                  <Heading className={section.level === 2 ? "text-xl font-semibold" : "text-base font-semibold sm:text-lg"}>
                    {section.heading}
                  </Heading>
                  {section.blocks.map((block, index) => (
                    <BlockView key={index} block={block} />
                  ))}
                </section>
              );
            })}
          </article>
        </main>

        <footer className="mt-6 text-sm">
          <a href={localePath(locale, "/")} className={LINK}>
            {t("toApp")}
          </a>
        </footer>
      </div>
    </div>
  );
}
