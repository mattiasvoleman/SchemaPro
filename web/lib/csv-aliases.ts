/**
 * The header spellings each CSV import reads, per kind and field, as `normalizeHeader` (lib/csv-export.ts) writes
 * them: case, spaces, punctuation and diacritics dropped.
 *
 * ONE LIST, TWO READERS. The row mappers of lib/csv.ts find a column by comparing a file's normalised headers to
 * these; the column mapping (lib/column-fields.ts, Kolumnmappning X2) places a file's columns by the same lists
 * before any mapper runs, and writes each placed column back under the field's own header. Were the two to keep a
 * list each, a spelling one of them learned would be a column the other drops, and a file that imports today would
 * lose a column the day the mapping step was added. So the lists live here, and nothing else.
 *
 * Data only and no imports: the column mapping loads it, and so does lib/csv.ts, and neither may pull the other in
 * for it. A field's first spelling is the one the template writes, or the nearest (a template header carries
 * underscores that the normalisation drops: "elev_epost" reads "elevepost").
 *
 * A column in this list that its mapper does not write would read as "no teacher" (or no whatever) and take the stored
 * value off: add a spelling only together with the mapper's reading of the field.
 */

/** Telefon, as the pupils', guardians' and teachers' files spell it. */
export const PHONE_ALIASES = ["telefon", "telefonnummer", "tel", "mobil", "mobilnummer", "phone"];

export const CSV_ALIASES = {
  students: {
    firstName: ["fornamn", "firstname"],
    lastName: ["efternamn", "lastname"],
    email: ["epost", "email", "epostadress"],
    phone: PHONE_ALIASES,
    className: ["klass", "class"],
  },
  guardians: {
    firstName: ["fornamn", "firstname"],
    lastName: ["efternamn", "lastname"],
    email: ["epost", "email", "epostadress"],
    phone: PHONE_ALIASES,
    // normalizeHeader strips the underscore: "elev_epost" reads "elevepost".
    studentEmail: ["elevepost", "elevensepost", "elevemail", "studentemail", "pupilemail"],
  },
  teachers: {
    firstName: ["fornamn", "firstname"],
    lastName: ["efternamn", "lastname"],
    email: ["epost", "email", "epostadress"],
    phone: PHONE_ALIASES,
    employmentPercent: ["tjanstprocent", "tjanst", "tjanstgoringsgrad", "tjanstgoringsgradprocent", "employmentpercent"],
    reductionPercent: ["nedsattningprocent", "nedsattning", "reductionpercent"],
    contractKind: ["avtal", "avtalsform", "contractkind", "tjanstetyp"],
    signature: ["signatur", "signature", "sign", "lararsignatur"],
  },
  classes: {
    name: ["namn", "name", "klass"],
    gradeLevel: ["arskurs", "gradelevel", "ak"],
    kind: ["typ", "kind", "grupptyp"],
    halfOf: ["halvklassav", "halvav", "halfof"],
    replacesSubject: ["ersatteramne", "ersatter", "replacessubject"],
  },
  teachingGroups: {
    groupName: ["grupp", "group", "undervisningsgrupp"],
    email: ["epost", "email", "epostadress", "elev"],
  },
  roomTypes: {
    name: ["namn", "name", "salstyp", "typ"],
  },
  rooms: {
    name: ["namn", "name", "sal", "rum"],
    code: ["kod", "code", "salskod"],
    roomType: ["salstyp", "typ", "roomtype"],
    capacity: ["kapacitet", "platser", "antalplatser", "capacity"],
    minGradeLevel: ["lagstaarskurs", "franarskurs", "mingrade"],
    maxGradeLevel: ["hogstaarskurs", "tillarskurs", "maxgrade"],
    building: ["byggnad", "hus", "building"],
    floor: ["vaning", "plan", "floor"],
  },
  subjects: {
    name: ["namn", "name", "amne"],
    code: ["kod", "code", "forkortning"],
    color: ["farg", "color"],
    roomType: ["salstyp", "kraversalstyp", "roomtype"],
    nationalCode: ["nationellkod", "nationellamneskod", "nationalcode", "skolverketskod", "skolverketkod"],
    countsTowardTimplan: ["undervisningstid", "raknassomundervisningstid", "countstowardtimplan", "undervisningsamne"],
  },
  requirements: {
    groupName: ["grupp", "group", "undervisningsgrupp", "klass", "class"],
    subject: ["amne", "amneskod", "subject", "subjectcode", "kod", "code"],
    lessonsPerWeek: ["lektionerpervecka", "lektionervecka", "lektioner", "antallektioner", "lessonsperweek"],
    minutesPerLesson: ["minuterperlektion", "minuterlektion", "minuter", "lektionslangd", "minutesperlesson"],
    // Not "lektionslangd", which is minutesPerLesson above: the plural is a different column, the one that can say "1x80+1x40".
    lessonLengths: ["lektionslangder", "langder", "lessonlengths"],
    // The template writes the API's field name; the Swedish spellings are here because an administrator who adds the column
    // by hand writes what the timplan page calls it. "minuter" alone is taken by minutesPerLesson above. A bare "fore" and
    // "efter" are deliberately NOT accepted: they are the words a school also writes over a pair of date or time columns.
    minutesBefore: ["minutesbefore", "ombytefore", "minuterfore"],
    minutesAfter: ["minutesafter", "duschefter", "ombyteefter", "minuterefter"],
    teacherEmail: ["larare", "undervisandelarare", "lararepost", "teacher", "teacheremail"],
    // A teacher by the signature the staff list carries instead of by e-mail (a Skola24 Tjänstefördelning names no addresses).
    teacherSignature: ["lararesignatur", "lararsignatur", "teachersignature"],
    coTeacherEmail: ["medlarare", "medlararepost", "andralarare", "larare2", "coteacher", "coteacheremail"],
    coTeacherSignature: ["medlararesignatur", "medlarsignatur", "coteachersignature"],
    // Never a bare "procent": a school's own sheet may carry a tjänstegrad column under that word, and reading it as a charge
    // would quietly halve every row. Each spelling names whose percentage it is.
    teacherLoadPercent: ["larareprocent", "lararprocent", "lararensprocent", "raknasforlarare", "raknasforlararen", "teacherloadpercent"],
    coTeacherLoadPercent: ["medlararprocent", "medlarareprocent", "raknasformedlarare", "raknasformedlararen", "coteacherloadpercent"],
    recurrence: ["veckor", "vecka", "weeks", "recurrence"],
    // "Fr.o.m." normalizes to "from", not "fom": the dots are stripped, not the letters between them. Both are listed.
    startDate: ["fran", "franochmed", "from", "fom", "start", "startdatum", "startdate"],
    endDate: ["till", "tillochmed", "tom", "slut", "slutdatum", "enddate"],
  },
  teacherQualifications: {
    teacherEmail: ["larareepost", "larare", "epost", "email", "epostadress", "teacheremail"],
    subject: ["amne", "amneskod", "subject", "subjectcode", "kod", "code"],
    minGrade: ["franarskurs", "fran", "lagstaarskurs", "minarskurs", "mingrade", "from"],
    maxGrade: ["tillarskurs", "till", "hogstaarskurs", "maxarskurs", "maxgrade", "to"],
    kind: ["behorighet", "slag", "kind", "typ"],
  },
  teacherDuties: {
    teacherEmail: ["larareepost", "larare", "epost", "email", "teacheremail"],
    kind: ["typ", "uppdragstyp", "kind"],
    label: ["benamning", "namn", "uppdrag", "label"],
    minutesPerWeek: ["minuterpervecka", "minuter", "minutesperweek", "minutes"],
    countsAsTeaching: ["raknassomundervisning", "raknas", "countsasteaching"],
    subject: ["amne", "amneskod", "subject"],
    groupName: ["grupp", "klass", "group", "groupname"],
    // As the timplan file spells its period, "Fr.o.m." included.
    validFrom: ["fran", "franochmed", "from", "fom", "giltigfran", "validfrom"],
    validTo: ["till", "tillochmed", "tom", "giltigtill", "validto"],
    note: ["anteckning", "kommentar", "note"],
  },
} satisfies Record<string, Record<string, string[]>>;
