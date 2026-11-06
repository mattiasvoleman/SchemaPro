import { redirect } from "next/navigation";
import { createTranslator } from "next-intl";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { viewerAddressOf, viewerHref } from "@/lib/public-timetable";

/*
 * Where a code is typed (Schemavisarens lägen, 20270118090000): Fritext-ID.
 * A school may show a kind of schedule only to the person who holds its exact
 * code and keep every list of it closed; this is the page such a person opens
 * to use the code, when they were given the code and not a link.
 *
 * A PLAIN FORM, NO SCRIPT. The viewer ships none, and a code is typed on a
 * phone off a letter: a GET form to this same page, read on the server. A
 * code in any spelling a person types it (small letters, hyphens or spaces,
 * I or L for 1, O for 0) is sent on to /v/<code>, where the viewer answers
 * as it does for any address. Anything that cannot be a code is answered
 * here with one neutral sentence — which says nothing about any code, only
 * about how a code is written: whether a well-formed code exists is the
 * viewer's one 404 and never this page's to say.
 *
 * The code travels in the query for the one request that redirects it into
 * the path. The page sends no referrer (layout, proxy) and indexes nothing.
 */

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

export default async function CodeEntryPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const search = await searchParams;
  const locale = search.lang === "en" ? "en" : "sv";
  const messages = locale === "en" ? en : sv;
  const t = createTranslator({ locale, messages, namespace: "publicViewer" }) as unknown as (key: string) => string;

  const typed = first(search.code)?.trim();
  if (typed) {
    const address = viewerAddressOf(typed);
    // redirect() throws: nothing below runs for a code that reads as one.
    if (address !== null) redirect(viewerHref(address, { lang: locale }));
  }

  const other = locale === "en" ? "sv" : "en";
  return (
    <main lang={locale} className="mx-auto max-w-xl space-y-6 px-4 py-16">
      <title>{t("codeTitle")}</title>
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("codeTitle")}</h1>
        <p>{t("codeBody")}</p>
      </div>
      <form method="get" action="/v" className="space-y-3">
        {/* The page stays in the language it was opened in. */}
        {locale === "en" ? <input type="hidden" name="lang" value="en" /> : null}
        <div className="space-y-1.5">
          <label htmlFor="code" className="block text-sm font-medium">
            {t("codeLabel")}
          </label>
          <input
            id="code"
            name="code"
            type="text"
            defaultValue={typed ?? ""}
            required
            maxLength={64}
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby={typed ? "code-hint code-error" : "code-hint"}
            aria-invalid={typed ? true : undefined}
            className="block h-11 w-full rounded-md border border-neutral-500 bg-white px-3 font-mono text-lg uppercase tracking-wider focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
          />
          <p id="code-hint" className="text-xs">
            {t("codeHint")}
          </p>
          {typed ? (
            <p id="code-error" role="alert" className="text-sm font-medium text-red-800">
              {t("codeInvalid")}
            </p>
          ) : null}
        </div>
        <button
          type="submit"
          className="inline-flex h-11 items-center rounded-md bg-neutral-900 px-5 text-sm font-medium text-white hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
        >
          {t("codeOpen")}
        </button>
      </form>
      <p className="text-xs print:hidden">
        <a href={locale === "en" ? "/v" : "/v?lang=en"} lang={other} className="underline underline-offset-4">
          {t("otherLanguage")}
        </a>
        {" · "}
        <a href={`/${locale}/tillganglighet`} className="underline underline-offset-4">
          {t("accessibility")}
        </a>
      </p>
    </main>
  );
}
