"use client";

/*
 * Inbäddning (Utskrift och inbäddning, 20261102090000): Schemavisaren in a
 * frame on the school's own website.
 *
 * OFF BY DEFAULT, PER AUDIENCE. Every viewer page refuses to be framed
 * anywhere (frame-ancestors 'none'); a share link's frame (/v/<token>/embed)
 * may be framed by the websites listed here, and only for the kinds turned
 * on: the classes for the families, the teachers for the substitutes, the
 * rooms for the visitors. A kind can be embedded only while the viewer shows
 * it at all — embedding adds a frame, not a field.
 *
 * THE WEBSITES are origins as frame-ancestors takes them: https, a host, an
 * optional port, no page. What an admin types is normalized by the gateway
 * (skolan.se → https://skolan.se); a page address or plain http is refused,
 * said here before saving and by the gateway authoritatively.
 *
 * THE CODE comes with the link: a link's address is shown once, when it is
 * made (LinksCard), and the code with it when the link may be embedded. A
 * school that already has its addresses pastes one here for the code.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy, Loader2 } from "lucide-react";
import type { MessageLookup } from "@/lib/engine-message";
import { useUpdatePublicationSettings } from "@/lib/publication-queries";
import { publicationErrorText } from "@/lib/publication-messages";
import type { PublicationSettings, PublicationSettingsInput } from "@/lib/publication-types";
import { embedSnippet, publicViewerEmbedUrl, tokenOfViewerUrl } from "@/lib/publication-view";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

type EmbedFlag = "publicEmbedGroups" | "publicEmbedTeachers" | "publicEmbedRooms";
const SCOPES: { flag: EmbedFlag; scope: "publicGroups" | "publicTeachers" | "publicRooms" }[] = [
  { flag: "publicEmbedGroups", scope: "publicGroups" },
  { flag: "publicEmbedTeachers", scope: "publicTeachers" },
  { flag: "publicEmbedRooms", scope: "publicRooms" },
];

export const MAX_SITES = 10;
/** An origin as the gateway stores it (src/publication/embed-origins.ts): https, a host of labels, a port a browser can have. */
const ORIGIN = /^https:\/\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(:(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3}))?$/;

/**
 * A typed website as the gateway reads it, or null when it would refuse it:
 * https assumed, the website alone (no path, query or login), and a name
 * with å, ä or ö in its punycode, as the browser and the gateway both write
 * it.
 */
function siteOf(typed: string): string | null {
  const value = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  const origin = `https://${url.host}`.toLowerCase();
  return ORIGIN.test(origin) ? origin : null;
}

/** The typed websites, one per line, and the lines the gateway would refuse. */
export function sitesOf(text: string): { sites: string[]; refused: string[] } {
  const sites = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return { sites, refused: sites.filter((site) => siteOf(site) === null) };
}

export function EmbedCard({ settings }: { settings: PublicationSettings }) {
  const t = useTranslations("publishing");
  const tErrors = useTranslations("publishing.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const update = useUpdatePublicationSettings();
  const [changes, setChanges] = useState<PublicationSettingsInput>({});
  const [sitesText, setSitesText] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");

  const value = <K extends EmbedFlag>(key: K) => changes[key] ?? settings[key];
  const text = sitesText ?? settings.publicEmbedOrigins.join("\n");
  const { sites, refused } = sitesOf(text);
  const tooMany = sites.length > MAX_SITES;
  const dirty = Object.keys(changes).length > 0 || sitesText !== null;
  const anyOn = SCOPES.some(({ flag }) => value(flag));

  const save = async () => {
    setProblem(null);
    try {
      await update.mutateAsync({ ...changes, ...(sitesText !== null ? { publicEmbedOrigins: sites } : {}) });
      setChanges({});
      setSitesText(null);
      toast.success(t("embedSaved"));
    } catch (error) {
      setProblem(publicationErrorText(tErrors, error, tCommon("error")));
    }
  };

  // A link of this SchemaPro, as the links above are: an address of another
  // site (a test server, an old address, a typo) would put a frame of
  // something else on the school's website.
  const token = (() => {
    const found = tokenOfViewerUrl(pasted);
    try {
      return found && new URL(pasted.trim()).origin === window.location.origin ? found : null;
    } catch {
      return null;
    }
  })();
  const snippet = token ? embedSnippet(publicViewerEmbedUrl(window.location.origin, token), t("embedFrameTitle")) : null;
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("embedCopied"));
    } catch {
      // The code is on screen, selectable; a refused clipboard costs nothing.
    }
  };

  return (
    <SectionCard
      id="publish-embed"
      title={t("embedTitle")}
      description={t("embedBody")}
      descriptionClassName="max-w-prose"
      footer={
        <Button onClick={save} disabled={!dirty || refused.length > 0 || tooMany || update.isPending}>
          {update.isPending ? (
            <>
              <Loader2 className="animate-spin" />
              {tCommon("saving")}
            </>
          ) : (
            tCommon("save")
          )}
        </Button>
      }
    >
      <ul className="space-y-2">
        {SCOPES.map(({ flag, scope }) => {
          const shown = settings.publicViewerEnabled && settings[scope];
          return (
            <li key={flag} className="flex items-start justify-between gap-4 rounded-md border p-3">
              <div className="min-w-0 space-y-1">
                <Label htmlFor={`embed-${flag}`}>{t(`embed.${flag}`)}</Label>
                <p id={`embed-${flag}-hint`} className="text-xs text-muted-foreground">
                  {shown ? t(`embed.${flag}Hint`) : t("embedScopeOff")}
                </p>
              </div>
              <Switch
                id={`embed-${flag}`}
                checked={value(flag)}
                disabled={!shown}
                onCheckedChange={(checked) => setChanges((previous) => ({ ...previous, [flag]: checked }))}
                aria-describedby={`embed-${flag}-hint`}
              />
            </li>
          );
        })}
      </ul>

      <FormField
        id="embed-sites"
        label={t("embedSites")}
        hint={t("embedSitesHint", { max: MAX_SITES })}
        error={
          refused.length > 0
            ? t("embedSitesRefused", { sites: refused.join(", ") })
            : tooMany
              ? t("embedSitesTooMany", { max: MAX_SITES })
              : undefined
        }
      >
        <Textarea
          rows={3}
          value={text}
          onChange={(event) => setSitesText(event.target.value)}
          placeholder="https://www.skolan.se"
          className="max-w-xl font-mono text-sm"
        />
      </FormField>
      {anyOn && sites.length === 0 ? <Notice tone="warning">{t("embedNoSites")}</Notice> : null}
      {problem ? <Notice tone="destructive">{problem}</Notice> : null}

      <div className="space-y-2 border-t pt-4">
        <FormField id="embed-paste" label={t("embedPaste")} hint={t("embedPasteHint")}>
          <Input value={pasted} onChange={(event) => setPasted(event.target.value)} placeholder="https://…/v/…" className="max-w-xl" />
        </FormField>
        {pasted.trim() && !token ? <p className="text-sm text-muted-foreground">{t("embedPasteNotALink")}</p> : null}
        {snippet ? (
          <div className="flex max-w-3xl items-start gap-2">
            <Textarea
              readOnly
              rows={3}
              value={snippet}
              aria-label={t("embedCode")}
              onFocus={(event) => event.target.select()}
              className="font-mono text-xs"
            />
            <Button variant="outline" size="icon" onClick={() => void copy(snippet)} title={t("embedCopy")} aria-label={t("embedCopy")}>
              <Copy />
            </Button>
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
