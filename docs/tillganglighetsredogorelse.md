# Tillgänglighetsredogörelse för SchemaPro

{Huvudmannens namn} står bakom SchemaPro, skolans tjänst för schema, närvaro och frånvaro. Vi vill att så många som möjligt ska kunna använda tjänsten. Den här redogörelsen beskriver hur SchemaPro uppfyller lagen om tillgänglighet till digital offentlig service, vilka tillgänglighetsproblem vi känner till och hur du kan rapportera brister till oss så att vi kan åtgärda dem.

Redogörelsen gäller webbtjänsten SchemaPro: inloggningen, alla sidor för skolans administratörer, lärare, elever och vårdnadshavare, och Schemavisaren, där skolan delar sitt publicerade schema med en länk. Den gäller inte SchemaPros mobilapp, som ännu inte finns i App Store eller Google Play. Appen får en egen redogörelse när den publiceras där.

## Hur tillgänglig är tjänsten?

Vi är medvetna om att delar av tjänsten inte är helt tillgängliga. Se avsnittet om innehåll som inte är tillgängligt nedan.

### Vad kan du göra om du inte kan använda delar av tjänsten?

Om du behöver innehåll från SchemaPro som inte är tillgängligt för dig kan du kontakta oss:

- E-post: [{e-postadress}](mailto:{e-postadress})
- Telefon: {telefonnummer}

Vi svarar normalt inom {antal} arbetsdagar.

## Rapportera brister i tjänstens tillgänglighet

Vi strävar hela tiden efter att förbättra tjänstens tillgänglighet. Om du upptäcker problem som inte beskrivs på den här sidan, eller om du anser att vi inte uppfyller lagens krav, meddela oss så att vi får veta att problemet finns: [{e-postadress}](mailto:{e-postadress}).

## Tillsyn

Myndigheten för digital förvaltning (Digg) har ansvaret för tillsyn över lagen om tillgänglighet till digital offentlig service. Om du inte är nöjd med hur vi hanterar dina synpunkter kan du [göra en anmälan till Digg](https://www.digg.se/analys-och-uppfoljning/lagen-om-tillganglighet-till-digital-offentlig-service-dos-lagen/anmal-bristande-tillganglighet).

## Teknisk information om tjänstens tillgänglighet

SchemaPro är delvis förenlig med lagen om tillgänglighet till digital offentlig service, på grund av de brister som beskrivs nedan. Kraven är nivå AA i WCAG 2.1, som standarden EN 301 549 hänvisar till.

## Innehåll som inte är tillgängligt

Det innehåll som beskrivs nedan är på ett eller annat sätt inte helt tillgängligt.

### Bristande förenlighet med lagkraven

- Tjänsten har inte testats av en person som använder skärmläsare. Den automatiska granskningen och ett manus för testet finns, men själva testet med VoiceOver och NVDA återstår. Tills det är gjort kan det finnas brister för den som använder skärmläsare som de automatiska testerna inte hittar (WCAG 1.3.1 Information och relationer, 2.4.3 Fokusordning, 4.1.2 Namn, roll, värde).
- Schemat som administratören exporterar som PDF är inte taggat, så en skärmläsare kan inte läsa ut dess tabell (WCAG 1.3.1 Information och relationer). Samma schema går att läsa på webben och att exportera som kalenderfil.

### Innehåll som inte omfattas av lagen

Vi känner inte till något innehåll i SchemaPro som är undantaget från lagen.

## Hur vi har testat tjänsten

Vi har gjort en självskattning (intern testning) av SchemaPro:

- Automatisk granskning med verktyget axe mot WCAG 2.1 nivå A och AA av varje sida i tjänsten: inloggningen, alla sidor för administratörer, lärare, elever och vårdnadshavare (som var och en av rollerna), Schemavisaren och den här redogörelsen, i dator- och mobilbredd och i ljust och mörkt tema (Schemavisaren har bara det ljusa). Granskningen körs vid varje ändring av tjänsten. Den granskar sidorna som de ser ut när de har laddats, och dessutom huvudmenyn på mobil och notismenyn öppna. Andra dialogrutor och menyer som öppnas med ett klick granskas inte automatiskt; de ingår i skärmläsartestet, som återstår.
- Granskning av vad hjälpmedel får veta om de viktigaste sidorna (namn, roller, rubriker och meddelanden), med sparade jämförelser som visar varje ändring.
- Tester av tangentbordsanvändning, synligt fokus och kontrast för inloggningen och schemaläggningen.
- Ett manus för testet med skärmläsare, med vad som ska höras i varje steg för de fyra rollerna. Själva testet återstår (se ovan).

Senaste bedömningen gjordes den 14 oktober 2026.

Redogörelsen uppdaterades senast den 14 oktober 2026.
