/**
 * SchemaPro's tillgänglighetsredogörelse, after Digg's model for lagen
 * (2018:1937) om tillgänglighet till digital offentlig service.
 *
 * The law binds the school's huvudman — a kommun, or the board of a
 * fristående skola — and not SchemaPro: the huvudman publishes the statement
 * for the service it offers. So who stands behind it and how to reach them
 * are the deployment's to say, from the server's environment (contactFromEnv):
 * ACCESSIBILITY_ORGANISATION, ACCESSIBILITY_EMAIL, ACCESSIBILITY_PHONE and
 * ACCESSIBILITY_RESPONSE_DAYS (docs/DEPLOYMENT.md §6). Until they are set the
 * page says the contact details are missing rather than show Digg's
 * {placeholders} to the public. Nothing here is a real address or number.
 *
 * One text, two places: the page renders statement(contactFromEnv()), and
 * docs/tillganglighetsredogorelse.md is toMarkdown(TEMPLATE) — the same text
 * with Digg's placeholders, as the huvudman's template — which
 * statement.test.ts holds the file to. Change the text here and rewrite the
 * file with `UPDATE_STATEMENT=1 npx vitest run "app/[locale]/tillganglighet"`.
 *
 * It is Swedish on both locales: the law asks for Swedish, and an English
 * translation would be a second document to keep true.
 */

export type Inline = string | { text: string; href: string };

export type Block = { kind: "p"; content: Inline[] } | { kind: "ul"; items: Inline[][] };

export interface Section {
  heading: string;
  level: 2 | 3;
  blocks: Block[];
}

const p = (...content: Inline[]): Block => ({ kind: "p", content });
const ul = (...items: Inline[][]): Block => ({ kind: "ul", items });

/** Digg's form for reporting a public body's inaccessible service. */
export const DIGG_REPORT_URL =
  "https://www.digg.se/analys-och-uppfoljning/lagen-om-tillganglighet-till-digital-offentlig-service-dos-lagen/anmal-bristande-tillganglighet";

export const UPDATED = "14 oktober 2026";

export const TITLE = "Tillgänglighetsredogörelse för SchemaPro";

/** Who stands behind the service and how to reach them; null when not set. */
export interface Contact {
  organisation: string | null;
  email: string | null;
  phone: string | null;
  /** Working days to an answer, as written: "5". */
  responseDays: string | null;
}

/** Digg's own placeholders: what docs/ holds, for a huvudman to fill in. */
export const TEMPLATE: Contact = {
  organisation: "{Huvudmannens namn}",
  email: "{e-postadress}",
  phone: "{telefonnummer}",
  responseDays: "{antal}",
};

/** The deployment's contact details, read on the server when the page renders. */
export function contactFromEnv(env: Record<string, string | undefined> = process.env): Contact {
  const read = (name: string) => {
    const value = env[name]?.trim();
    return value ? value : null;
  };
  return {
    organisation: read("ACCESSIBILITY_ORGANISATION"),
    email: read("ACCESSIBILITY_EMAIL"),
    phone: read("ACCESSIBILITY_PHONE"),
    responseDays: read("ACCESSIBILITY_RESPONSE_DAYS"),
  };
}

/** The statement for one deployment's contact details. */
export function statement(contact: Contact): { intro: Block[]; sections: Section[] } {
  const email = contact.email ? { text: contact.email, href: `mailto:${contact.email}` } : null;
  const reachable = contact.email !== null || contact.phone !== null;
  const intro: Block[] = [
    p(
      `${contact.organisation ? `${contact.organisation} står bakom SchemaPro, skolans` : "SchemaPro är skolans"} tjänst för schema, närvaro och frånvaro. Vi vill att så många som möjligt ska kunna använda tjänsten. Den här redogörelsen beskriver hur SchemaPro uppfyller lagen om tillgänglighet till digital offentlig service, vilka tillgänglighetsproblem vi känner till och hur du kan rapportera brister till oss så att vi kan åtgärda dem.`,
    ),
    p(
      "Redogörelsen gäller webbtjänsten SchemaPro: inloggningen, alla sidor för skolans administratörer, lärare, elever och vårdnadshavare, och Schemavisaren, där skolan delar sitt publicerade schema med en länk. Den gäller inte SchemaPros mobilapp, som ännu inte finns i App Store eller Google Play. Appen får en egen redogörelse när den publiceras där.",
    ),
  ];
  const missing = p(
    "Kontaktuppgifterna för tillgänglighetsfrågor är inte inlagda ännu. Till dess kan du kontakta din skola som du brukar, och du kan alltid göra en anmälan till Digg (se Tillsyn nedan).",
  );
  const sections: Section[] = [
    {
      heading: "Hur tillgänglig är tjänsten?",
      level: 2,
      blocks: [
        p(
          "Vi är medvetna om att delar av tjänsten inte är helt tillgängliga. Se avsnittet om innehåll som inte är tillgängligt nedan.",
        ),
      ],
    },
    {
      heading: "Vad kan du göra om du inte kan använda delar av tjänsten?",
      level: 3,
      blocks: [
        ...(reachable
          ? [
              p("Om du behöver innehåll från SchemaPro som inte är tillgängligt för dig kan du kontakta oss:"),
              ul(
                ...[email ? ["E-post: ", email] : null, contact.phone ? [`Telefon: ${contact.phone}`] : null].filter(
                  (item): item is Inline[] => item !== null,
                ),
              ),
              ...(contact.responseDays ? [p(`Vi svarar normalt inom ${contact.responseDays} arbetsdagar.`)] : []),
            ]
          : [missing]),
      ],
    },
    {
      heading: "Rapportera brister i tjänstens tillgänglighet",
      level: 2,
      blocks: [
        email
          ? p(
              "Vi strävar hela tiden efter att förbättra tjänstens tillgänglighet. Om du upptäcker problem som inte beskrivs på den här sidan, eller om du anser att vi inte uppfyller lagens krav, meddela oss så att vi får veta att problemet finns: ",
              email,
              ".",
            )
          : contact.phone
            ? p(
                `Vi strävar hela tiden efter att förbättra tjänstens tillgänglighet. Om du upptäcker problem som inte beskrivs på den här sidan, eller om du anser att vi inte uppfyller lagens krav, meddela oss så att vi får veta att problemet finns: ring ${contact.phone}.`,
              )
            : p(
              "Vi strävar hela tiden efter att förbättra tjänstens tillgänglighet. Om du upptäcker problem som inte beskrivs på den här sidan, eller om du anser att vi inte uppfyller lagens krav, meddela din skola så att problemet blir känt. Kontaktuppgifterna för tillgänglighetsfrågor är inte inlagda ännu.",
            ),
      ],
    },
    {
      heading: "Tillsyn",
      level: 2,
      blocks: [
        p(
          "Myndigheten för digital förvaltning (Digg) har ansvaret för tillsyn över lagen om tillgänglighet till digital offentlig service. Om du inte är nöjd med hur vi hanterar dina synpunkter kan du ",
          { text: "göra en anmälan till Digg", href: DIGG_REPORT_URL },
          ".",
        ),
      ],
    },
    {
      heading: "Teknisk information om tjänstens tillgänglighet",
      level: 2,
      blocks: [
        p(
          "SchemaPro är delvis förenlig med lagen om tillgänglighet till digital offentlig service, på grund av de brister som beskrivs nedan. Kraven är nivå AA i WCAG 2.1, som standarden EN 301 549 hänvisar till.",
        ),
      ],
    },
    {
      heading: "Innehåll som inte är tillgängligt",
      level: 2,
      blocks: [p("Det innehåll som beskrivs nedan är på ett eller annat sätt inte helt tillgängligt.")],
    },
    {
      heading: "Bristande förenlighet med lagkraven",
      level: 3,
      blocks: [
        ul(
          [
            "Tjänsten har inte testats av en person som använder skärmläsare. Den automatiska granskningen och ett manus för testet finns, men själva testet med VoiceOver och NVDA återstår. Tills det är gjort kan det finnas brister för den som använder skärmläsare som de automatiska testerna inte hittar (WCAG 1.3.1 Information och relationer, 2.4.3 Fokusordning, 4.1.2 Namn, roll, värde).",
          ],
          [
            "Schemat som administratören exporterar som PDF är inte taggat, så en skärmläsare kan inte läsa ut dess tabell (WCAG 1.3.1 Information och relationer). Samma schema går att läsa på webben och att exportera som kalenderfil.",
          ],
        ),
      ],
    },
    {
      heading: "Innehåll som inte omfattas av lagen",
      level: 3,
      blocks: [p("Vi känner inte till något innehåll i SchemaPro som är undantaget från lagen.")],
    },
    {
      heading: "Hur vi har testat tjänsten",
      level: 2,
      blocks: [
        p("Vi har gjort en självskattning (intern testning) av SchemaPro:"),
        ul(
          [
            "Automatisk granskning med verktyget axe mot WCAG 2.1 nivå A och AA av varje sida i tjänsten: inloggningen, alla sidor för administratörer, lärare, elever och vårdnadshavare (som var och en av rollerna), Schemavisaren och den här redogörelsen, i dator- och mobilbredd och i ljust och mörkt tema (Schemavisaren har bara det ljusa). Granskningen körs vid varje ändring av tjänsten. Den granskar sidorna som de ser ut när de har laddats, och dessutom huvudmenyn på mobil och notismenyn öppna. Andra dialogrutor och menyer som öppnas med ett klick granskas inte automatiskt; de ingår i skärmläsartestet, som återstår.",
          ],
          [
            "Granskning av vad hjälpmedel får veta om de viktigaste sidorna (namn, roller, rubriker och meddelanden), med sparade jämförelser som visar varje ändring.",
          ],
          ["Tester av tangentbordsanvändning, synligt fokus och kontrast för inloggningen och schemaläggningen."],
          ["Ett manus för testet med skärmläsare, med vad som ska höras i varje steg för de fyra rollerna. Själva testet återstår (se ovan)."],
        ),
        p(`Senaste bedömningen gjordes den ${UPDATED}.`),
        p(`Redogörelsen uppdaterades senast den ${UPDATED}.`),
      ],
    },
  ];
  return { intro, sections };
}


const inline = (part: Inline) => (typeof part === "string" ? part : `[${part.text}](${part.href})`);
const blockToMarkdown = (block: Block) =>
  block.kind === "p"
    ? block.content.map(inline).join("")
    : block.items.map((item) => `- ${item.map(inline).join("")}`).join("\n");

/** The text as Markdown; docs/tillganglighetsredogorelse.md is toMarkdown(TEMPLATE). */
export function toMarkdown(contact: Contact = TEMPLATE): string {
  const { intro, sections } = statement(contact);
  return [
    `# ${TITLE}`,
    ...intro.map(blockToMarkdown),
    ...sections.flatMap((section) => [
      `${"#".repeat(section.level)} ${section.heading}`,
      ...section.blocks.map(blockToMarkdown),
    ]),
  ].join("\n\n") + "\n";
}
