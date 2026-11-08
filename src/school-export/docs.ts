import { CSV_TEMPLATES } from './csv-files';
import type { DataFile } from './data-files';
import { ACCOUNT_KINDS, type TableFile } from './person-tables';
import { EXPORT_KEEP_HOURS, FORMAT_VERSION, ROWS_PER_PART } from './school-export';

/**
 * The two documents the zip opens with. README.txt says what the file is and
 * how to use it; FORMAT.md says what every column of every file in data/
 * holds. FORMAT.md is generated from the same column lists the files are
 * written from (data-files.ts), so a column cannot be added without its line,
 * and docs/school-export-format.md is the same text, held equal by a test.
 */

/** Order the lists are read back in: a file may name what an earlier one made. */
export const READ_BACK_ORDER = [
  'salstyper.csv',
  'salar.csv',
  'amnen.csv',
  'klasser.csv',
  'larare.csv',
  'behorigheter.csv',
  'elever.csv',
  'undervisningsgrupper.csv',
  'vardnadshavare.csv',
  'uppdrag.csv',
  'timplansposter.csv',
] as const;

export interface ReadmeInput {
  schoolName: string;
  createdAt: Date;
  kind: 'school' | 'person';
  /** Marked persons the file leaves out. */
  markedPeople: number;
  /** The person a registerutdrag is about (their name is the page's, not the file's). */
  subjectIsMarked?: boolean;
  /** Whether schema/grundschema.csv is in the file. The README names only the parts that are. */
  hasSchema?: boolean;
  /** What could not be made while the rest went on (the manifest's anmarkningar), said first. */
  notes?: readonly string[];
  /** The tables a registerutdrag leaves out, each with its reason. */
  excluded?: ReadonlyArray<{ table: string; reason: string }>;
}

const OUT = [
  'Lösenord och inloggningsuppgifter. De ligger hos inloggningstjänsten, inte i Rastra.',
  'Personnummer. Rastra lagrar inga.',
  'Notisinställningar, enheter för push-notiser och kalenderflödens adresser. De hör till varje persons eget konto och ingen administratör kan läsa dem.',
  'De publicerade lektionerna dag för dag. Grundschemat ingår, och de lektioner som närvaron hör till.',
  'Tjänster, tjänstelogg, lärares frånvaro och vikarieuppdrag, lektionsloggar, rastvakter, rapporteringsgrad per lärare och dag, och krislägets larm, uppropslistor och rapporter. De ingår i registerutdraget för en person, inte i skolans fil.',
  'Genereringsloggar, schemaförslag och synkningens körningar.',
];

export function readmeText(input: ReadmeInput): string {
  const day = input.createdAt.toISOString().slice(0, 10);
  const person = input.kind === 'person';
  const lines: string[] = [
    person ? 'Rastra: registerutdrag (GDPR artikel 15)' : 'Rastra: hela skolans data',
    '='.repeat(person ? 40 : 28),
    '',
    `Skola:   ${input.schoolName}`,
    `Skapad:  ${input.createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
    `Format:  rastra-skolexport, version ${FORMAT_VERSION}`,
    '',
    person
      ? 'Det här är alla uppgifter Rastra har om personen, i filer som går att öppna i Excel.'
      : 'Det här är skolans data i filer som går att öppna i Excel och läsa in i ett annat system.',
    person ? '' : `Filen finns att hämta i ${EXPORT_KEEP_HOURS} timmar efter att den skapats. Därefter raderas den; beställ en ny vid behov.`,
    '',
    ...(input.notes && input.notes.length > 0
      ? ['Delar som saknas', '----------------', ...input.notes.map((note) => `- ${note}`), 'Resten av filen är hel.', '']
      : []),
    'Vad som finns var',
    '------------------',
    ...(person ? [] : ['csv/         Listorna som sidorna exporterar som CSV, i det format som importen läser (se "Läs in listorna igen").']),
    ...(person || !input.hasSchema ? [] : ['schema/      Grundschemat som en tabell (samma fil som Schema som fil ger).']),
    'data/        Personer, kopplingar, närvaro, frånvaroanmälningar, ledigheter, notiser och läsloggen. Kolumnerna står i FORMAT.md.',
    ...(person ? ['data/person/ Övriga tabeller där Rastra har en rad om personen, en fil per tabell.'] : []),
    'manifest.json  Varje fils sökväg, antal rader, storlek och SHA-256, och hur många personer med skyddad identitet som hålls utanför.',
    'FORMAT.md    Vad varje kolumn i data/ innehåller.',
    '',
    'Filformatet',
    '-----------',
    'Alla CSV-filer är UTF-8 med BOM, semikolon som avgränsare och CRLF som radslut: det Excel på svenska öppnar rätt.',
    'En cell som börjar med =, +, - eller @ har fått ett inledande apostrof så att Excel inte kör den som en formel.',
    `En fil med fler än ${ROWS_PER_PART.toLocaleString('sv-SE').replace(/\s/g, ' ')} rader delas i delar (narvaro.csv, narvaro-2.csv ...), eftersom Excel öppnar 1 048 576 rader.`,
    'Tider i data/ är UTC (slutar på Z) utom lektionernas start och slut, som är skolans lokala tid.',
  ];
  if (!person) {
    lines.push(
      '',
      'Läs in listorna igen',
      '--------------------',
      'Filerna i csv/ är desamma som sidorna exporterar och läses in med Importera CSV på respektive sida, i den här ordningen,',
      'eftersom en fil kan peka på det en tidigare gjort:',
      ...READ_BACK_ORDER.map((file, index) => `  ${index + 1}. csv/${file}`),
      '  och sist csv/lokal_timplan/ (en fil per lokal timplan) på sidan Timplan.',
      'Listorna gäller det aktiva läsåret. Äldre läsår finns i data/ (närvaro, frånvaroanmälningar, ledigheter), inte som listor.',
    );
  }
  lines.push(
    '',
    'Skyddad identitet',
    '-----------------',
    person && input.subjectIsMarked
      ? 'Personen har en markering för skyddad identitet. Utdraget är personens egna uppgifter, och ingen annan person pekas ut i det: kolumner som skulle ha pekat ut en vårdnadshavare, en lärare eller en kollega (motparten i en koppling, vem som registrerade, anmälde, ansökte, beslutade eller läste) är tomma, i data/ och i data/person/, och manifestet räknar dem. Anteckningar som skolans personal skrivit om personen är personens egna uppgifter och finns kvar som de skrevs, utom där de nämner en annan person med skyddad identitet med id, fullständigt namn (i båda ordningarna) eller e-postadress; en anteckning kan ändå nämna en annan person vid förnamn eller med ord som "mamma", så läs den innan utdraget lämnas ut. Notisernas innehåll (data/notiser.csv) kontrolleras inte för andra personers namn eller adresser: läs det också. Lämna utdraget till personen själv och till ingen annan innan du har kontrollerat vem som frågar.'
      : input.markedPeople === 0
        ? 'Skolan har inte markerat någon person med skyddad identitet, så ingen är utelämnad.'
        : `${input.markedPeople} ${input.markedPeople === 1 ? 'person' : 'personer'} med skyddad identitet finns inte i filen, och inte heller raderna som handlar om ${input.markedPeople === 1 ? 'personen' : 'dem'}. Där en markerad person bara nämns i en kolumn som inte är det raden handlar om (vem som registrerade en närvaro, vem som beslutade en ledighet) är cellen tom. En anteckning, ett skäl eller en notis som nämner en markerad person med id, fullständigt namn (i båda ordningarna) eller e-postadress är tom, hur mellanrum, bindestreck och stora bokstäver än är skrivna. Ett förnamn ensamt, ett smeknamn, en annan stavning (ett namn utan prickar) och ord som "mamma" hittas inte, så läs fritext innan filen lämnas vidare. Manifestet säger hur många rader och celler det gäller i varje fil.`,
    person
      ? ''
      : 'Grundschemat nämner lärare vid signatur, namn och e-postadress, som Schema som fil gör, och en markerad lärare finns kvar där. En markerad person som håller en lektion utan att vara lärare eller administratör (en elev eller vårdnadshavare som lagts på lektionen) nämns inte; lektionen står utan lärare, och det står under Delar som saknas.',
    '',
    'Vad filen inte innehåller',
    '-------------------------',
    ...OUT.filter((line) => !(person && line.startsWith('Tjänster')))
      .map((line) => (person && line.startsWith('Genereringsloggar') ? 'Genereringsloggar, schemaförslag och synkningens körningar, utom de rader som visar att personen själv gjorde något (data/person/).' : line))
      .map((line) => `- ${line}`),
    ...(person
      ? [
          '- Personens egna kontouppgifter, som ingen administratör kan läsa och som personen ser i appen under Inställningar:',
          ...Object.values(ACCOUNT_KINDS).map((line) => `    ${line}`),
          ...(input.excluded ?? []).map((item) => `- ${item.table}: ${item.reason}`),
        ]
      : []),
    '',
    ...(person
      ? [
          'Andra personer i utdraget',
          '-------------------------',
          'Utdraget gäller en person. I en rad som inte handlar om personen själv (en lärare som beslutat en elevs ledighet, en vårdnadshavare som anmält en frånvaro) är elevens id, e-postadress, skäl, typ och anteckning tomma; det som finns kvar är personens egen handling: datum, status och beslut. Samma gäller tabellfilerna i data/person/: i en rad om en elev som utdraget inte gäller (en lärare som angett en elev som hittad i en övning) är elevens id och status tomma, och handlingen står kvar. Anteckningar som personen själv skrivit (larmets slutanteckning, lektionsloggar) är personens egna uppgifter och finns kvar, utom där de nämner en annan elev eller vårdnadshavare med fullständigt namn (i båda ordningarna) eller e-postadress; ett förnamn ensamt och en beskrivning hittas inte. Vill du ha barnets uppgifter beställer du utdraget för barnet, med vårdnadshavarna om de ska vara med.',
          '',
        ]
      : []),
    'Kontrollera filen',
    '-----------------',
    'manifest.json har en SHA-256 för varje fil. Stämmer den inte med filen du har har den ändrats eller skadats på vägen.',
    `Dokumentet skrevs ${day}.`,
  );
  return lines.filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\r\n') + '\r\n';
}

/** FORMAT.md: the columns of every data file. Generated; the committed copy in docs/ is held equal. */
export function formatDocument(files: readonly DataFile[], tables: readonly TableFile[] = []): string {
  const out: string[] = [
    '# Hela skolans data: filformat',
    '',
    `Formatet heter \`rastra-skolexport\`, version ${FORMAT_VERSION}. Ändras en kolumn höjs versionen.`,
    '',
    'Filerna i `data/` skrivs för den som vill ha allt. Till skillnad från listorna i `csv/` bär de id:n (nycklarna mellan filerna), e-postadressen bredvid varje id, och varje rad skolan har, aktiv eller inte. Alla är CSV: UTF-8 med BOM, semikolon, CRLF.',
    '',
    '## Listorna i `csv/`',
    '',
    'Det här är filerna sidorna exporterar. Kolumnerna är de importen läser; se manualen (Importera CSV) för vad varje kolumn betyder.',
    '',
    '| Fil | Kolumner |',
    '|---|---|',
    ...Object.values(CSV_TEMPLATES).map((file) => `| \`${file.filename}\` | ${file.headers.map((h) => `\`${h}\``).join(', ')} |`),
    '',
  ];
  for (const file of files) {
    out.push(`## \`${file.path}\`: ${file.title}`, '', `Källa: ${file.source}.`, '', '| Kolumn | Innehåll |', '|---|---|');
    for (const column of file.columns) out.push(`| \`${column.name}\` | ${column.doc.replace(/\|/g, '\\|')} |`);
    out.push('');
  }
  if (tables.length > 0) {
    out.push(
      '## `data/person/`: övriga tabeller',
      '',
      'Det Rastra i övrigt har om personen skrivs som en fil per tabell. Kolumnerna är tabellens egna, i tabellens ordning, och id:n är Rastras interna id:n (de som `data/personer.csv` bär). En kolumn som innehåller en nyckel, ett hemligt värde eller en kontrollsumma står som `(dold)`, och det gör också namnet och kontaktuppgifterna hos en extern hyrande i `ExternalBookings` (den som hyr är ingen användare och inte den som utdraget gäller; kvar står att personen registrerat serien). En tabell utan rader för personen skrivs inte. Tabellerna: ' +
        tables.map((table) => `\`${table.table}\``).join(', ') +
        '.',
      '',
    );
  }
  return out.join('\n');
}
