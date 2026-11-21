import type { Metadata } from "next";
import { CalendarRange, ShieldCheck } from "lucide-react";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import { localePath } from "@/i18n/paths";
import { flattenLabels, sayWith, type Labels } from "@/lib/pseudonym-labels";
import { PseudonymiserareTool } from "./tool";
import { LINK } from "./styles";

/**
 * Pseudonymiseraren (X1): take the personal data out of a file in the browser, before it is sent to anyone.
 *
 * PUBLIC, and outside the app's shell on purpose. A school that is not a customer yet is the one whose example files we need, so the page asks for no
 * sign-in (proxy.ts lets it through, as it does the tillgänglighetsredogörelse), and a route outside the (app) layout is the only place the browser
 * can be told it may make no request at all: the signed-in app has to reach its API, mounts react-query and opens sockets. The proxy gives this
 * route its own Content-Security-Policy (lib/pseudonym-policy.ts: connect-src 'none'), which is the half of the promise that does not rest on reading
 * our code. The other halves are in the tests: pseudonym-offline.test.ts reads the code for anything that sends or stores, and the component
 * test runs the whole flow with every way out replaced by a trap.
 *
 * Server-rendered, with only the tool hydrating, and no next-intl client runtime: the sentences are resolved here and handed to the tool as a
 * prop, as the sign-in page does. Plain <a> and localePath, not next/link, whose router would be this page's only other script (and whose prefetch
 * is a request).
 */

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pseudonymiserare");
  // A tool for the schools we are in touch with, not a landing page: no index, and no one is sent here by a search engine.
  return { title: t("metaTitle"), description: t("metaDescription"), robots: { index: false, follow: false } };
}

export default async function PseudonymiseraPage() {
  const locale = await getLocale();
  const tCommon = await getTranslations("common");
  const messages = (await getMessages()) as Record<string, unknown>;
  const labels = flattenLabels(messages["pseudonymiserare"]) as Labels;
  const say = sayWith(labels, locale);
  const otherLocale = locale === "sv" ? "en" : "sv";

  return (
    <div className="min-h-screen bg-muted/40 px-4 py-10">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-md">
              <CalendarRange className="h-5 w-5" aria-hidden="true" />
            </div>
            <a href={localePath(locale, "/")} className="text-lg font-semibold leading-tight hover:underline">
              {tCommon("appName")}
            </a>
          </div>
          <a href={localePath(otherLocale, "/pseudonymisera")} lang={otherLocale} hrefLang={otherLocale} className={LINK}>
            {say("footer.otherLanguage")}
          </a>
        </header>

        <main className="space-y-8">
          <div className="rounded-xl border bg-card p-6 text-card-foreground shadow-sm sm:p-10">
            <h1 className="text-2xl font-semibold tracking-tight">{say("title")}</h1>
            <p className="mt-4 max-w-3xl text-sm leading-relaxed sm:text-base">{say("intro")}</p>

            <section aria-labelledby="promise-heading" className="mt-6 rounded-lg border border-success/40 bg-success/10 p-4 sm:p-6">
              <h2 id="promise-heading" className="flex items-center gap-2 text-lg font-semibold">
                <ShieldCheck className="h-5 w-5 shrink-0" aria-hidden="true" />
                {say("promise.heading")}
              </h2>
              <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed sm:text-base">
                <li>{say("promise.offline")}</li>
                <li>{say("promise.policy")}</li>
                <li>{say("promise.nothingKept")}</li>
                <li>{say("promise.cannotJudge")}</li>
              </ul>
            </section>

            <p className="mt-6 max-w-3xl text-sm leading-relaxed text-muted-foreground">{say("formats")}</p>
          </div>

          <PseudonymiserareTool labels={labels} locale={locale} />
        </main>

        <footer className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <a href={localePath(locale, "/")} className={LINK}>
            {say("footer.toApp")}
          </a>
          <a href={localePath(locale, "/tillganglighet")} className={LINK}>
            {say("footer.accessibility")}
          </a>
        </footer>
      </div>
    </div>
  );
}
