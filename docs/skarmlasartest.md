# Skärmläsartest av SchemaPro – manus

Det här är manuset för det inspelade skärmläsartestet som tillgänglighetsredogörelsen ([tillganglighetsredogorelse.md](tillganglighetsredogorelse.md)) säger återstår. Testet görs av en person med en riktig skärmläsare. Manuset ska göra testet snabbt och möjligt att upprepa. Det täcker de viktigaste uppgifterna för de fyra rollerna: administratör, lärare, elev och vårdnadshavare. För varje steg står vad skärmläsaren ska säga.

De automatiska testerna gör redan två saker vid varje ändring:

- **axe** granskar varje sida, för varje roll, i ljust och mörkt tema och i dator- och mobilbredd (`web/e2e/a11y-app.spec.ts`).
- **Tillgänglighetsträdet**, alltså det skärmläsaren får veta, jämförs för skärmarna nedan med sparade versioner i `web/e2e/aria-baselines/`.

Tre saker kan bara en människa avgöra: om det skärmläsaren faktiskt säger går att förstå, om ordningen känns rimlig och om uppgiften går att slutföra.

## Förberedelser

**Miljö.** Testa i en testmiljö med påhittade uppgifter, aldrig i produktion med riktiga elever. Använd fyra testkonton: en administratör, en lärare, en elev och en vårdnadshavare med två barn. Manuset utgår från en skola som liknar testernas Exempelskolan: klasser i åk 7–9, en inställd lektion i veckan, en lärare som är frånvarande och ett par väntande ledighetsansökningar. Namnen nedan är därifrån. Byt ut dem mot testmiljöns egna.

**Skärmläsare och webbläsare.** Gör hela manuset med minst två av dessa kombinationer:

| Skärmläsare | Webbläsare | System |
| :-- | :-- | :-- |
| NVDA (senaste versionen) | Firefox eller Chrome | Windows |
| VoiceOver | Safari | macOS |
| VoiceOver | Safari | iPhone, för mobilbredd (avsnitt 5) |

**Inspelning.** Spela in skärmen med ljud, så att det skärmläsaren säger hörs. Spara en inspelning per roll och kombination, och ange namnet på inspelningen i protokollet.

**Vanliga kommandon.**

| Vad | NVDA | VoiceOver (macOS) |
| :-- | :-- | :-- |
| Nästa rubrik | H | VO + Cmd + H |
| Lista rubriker och landmärken | NVDA + F7 | VO + U (rotorn) |
| Nästa landmärke | D | Rotorn: Landmärken |
| Nästa formulärfält | F | VO + Cmd + J |
| Nästa knapp | B | Rotorn: Formulärkontroller |
| Nästa tabell | T | VO + Cmd + T |
| Läs från markören | NVDA + pil ned | VO + A |
| Fokusläge / bläddringsläge | NVDA + mellanslag | – |

## Så fyller du i protokollet

Ett protokoll per roll och kombination, med en rad per steg:

| Steg | Hörde (ordagrant om det avviker) | Roll, namn och tillstånd hörs? | Uppgiften gick att göra? | Avvikelse |
| :-- | :-- | :-- | :-- | :-- |

Skärmläsarna formulerar sig olika. NVDA säger "rubrik, nivå 1, Översikt" och VoiceOver "Översikt, rubrik nivå 1". Det som räknas är att rollen (rubrik, knapp, kryssruta, flik), namnet ("Översikt") och tillståndet (vald, ikryssad, inaktiv) hörs, och att inget annat hörs än det som står i manuset. Skriv ner det som avviker ordagrant, med tid i inspelningen.

Skriv också upp sådant som manuset inte frågar efter: ett fokus som hoppar till början av sidan, något som läses två gånger, ett meddelande som aldrig sägs.

## 0. Alla roller: logga in

| Steg | Gör | Ska höra |
| :-- | :-- | :-- |
| 0.1 | Öppna inloggningssidan | Sidans titel, sedan rubrik nivå 1 "Välkommen tillbaka". Landmärkena huvudinnehåll och sidfot finns i landmärkeslistan. |
| 0.2 | Tabba genom sidan | Redigeringsfält "E-post", länk "Glömt lösenordet?", redigeringsfält "Lösenord", knapp "Logga in", knapp "Logga in med skolkonto" (om skolan har det), länk "Tillgänglighetsredogörelse" |
| 0.3 | Skriv fel lösenord och tryck Retur | "Fel e-post eller lösenord." sägs utan att du flyttar dig |
| 0.4 | Logga in med rätt uppgifter | Den nya sidans titel och rubrik |
| 0.5 | Tryck Tabb en gång på första sidan efter inloggningen | Länk "Hoppa till innehållet". Retur flyttar till sidans rubrik, och nästa Tabb går till sidans första kontroll, inte tillbaka till menyn. |

## 1. Administratör

**1.1 Översikten och menyn.**

| Steg | Gör | Ska höra |
| :-- | :-- | :-- |
| 1.1.1 | Lista landmärkena | Banner (sidhuvudet), navigering "Huvudmeny", huvudinnehåll |
| 1.1.2 | Gå igenom menyn | Grupperna Grunddata, Planering, Schemaläggning och Drift som namngivna listor, varje sida som en länk. Den sida du står på sägs som aktuell sida. Sist kommer länken "Tillgänglighetsredogörelse". |
| 1.1.3 | Gå till sidhuvudet | Knapp "Språk", knapp "Tema", knapp "Notiser" (med antalet olästa, till exempel "Notiser, 2 olästa") och en knapp med ditt namn |
| 1.1.4 | Rubriker på Översikt | Nivå 1 "Översikt", nivå 2 "Snabbåtgärder". Nyckeltalen läses som par av term och värde, till exempel "Elever 9". |

**1.2 Personer: hitta och åtgärda en person.**

| Steg | Gör | Ska höra |
| :-- | :-- | :-- |
| 1.2.1 | Öppna Personer | Rubrik nivå 1 "Personer". Flikgrupp "Roll" med flikarna Alla (vald), Elev, Lärare, Administratör och Vårdnadshavare. |
| 1.2.2 | Gå till tabellen | Tabell med namn ("Skolans personer med e-post, roll, klass …") och antal rader och kolumner. Kolumnrubrikerna läses när du flyttar dig i sidled. |
| 1.2.3 | Flytta till en persons namnknapp och tryck Retur | Knapp "Bo Ek", hopfälld, sedan utfälld efter Retur. Raden under visar klass, grupper och tjänst. |
| 1.2.4 | Gå till åtgärderna på raden | Knappar som säger vem de gäller: "Redigera Bo Ek", "Ändra arbetstid för Bo Ek", "Ta bort Bo Ek" |
| 1.2.5 | Välj fliken Lärare med piltangenterna | Fliken sägs som vald, och tabellen visar bara lärare |

**1.3 Grundschema: flytta en lektion med tangentbordet.**

| Steg | Gör | Ska höra |
| :-- | :-- | :-- |
| 1.3.1 | Öppna Grundschema | Rubrik nivå 1 "Grundschema", och raden som förklarar hur schemat redigeras. Den säger att piltangenterna flyttar en lektion och att Retur öppnar den. |
| 1.3.2 | Tabba till första lektionen | Knapp med dag, tid och lektion, till exempel "Måndag 08:10–09:10, Svenska 7A · A. Lind Sal 101" |
| 1.3.3 | Tryck pil höger | "Lektionen uppdaterad …" sägs (ett meddelande, utan att fokus flyttas). Fokus står kvar på samma lektion, som nu heter "Tisdag 08:10–09:10, …". |
| 1.3.4 | Tryck pil ned | Lektionen flyttas 15 minuter, och tiden i namnet följer med |
| 1.3.5 | Gå till knappen "Ångra" och välj den | Lektionen går tillbaka |
| 1.3.6 | Tryck Retur på en lektion | En dialog "Justera lektion" öppnas, och fokus står i dialogen. Escape stänger den, och fokus går tillbaka till lektionen. |
| 1.3.7 | Gå till Parkering | Rubrik nivå 2 "Parkering" och en lista där varje parkerad lektion har en knapp "Sätt tillbaka" |

**1.4 Ledighetsansökningar: bevilja en ansökan.**

| Steg | Gör | Ska höra |
| :-- | :-- | :-- |
| 1.4.1 | Öppna Ledighetsansökningar | Rubrik nivå 1. Flikgrupp "Visa ansökningar" med Väntar (vald), Beviljad och Avslagen. Rubrik nivå 2 "Väntar på beslut". |
| 1.4.2 | Gå igenom första ansökan | Elevens namn och perioden med mellanslag emellan ("Ines Vik, 20–24 okt"), sedan anledningen och vem som ansökte |
| 1.4.3 | Gå till kommentarsfältet | Redigeringsfält "Kommentar till vårdnadshavaren, Ines Vik, 20–24 okt (valfritt)" |
| 1.4.4 | Välj "Bevilja" | Knappens namn är "Bevilja Ines Vik, 20–24 okt". Efteråt sägs "Beviljad — …". |

**1.5 Vikarietavla: tillsätt en vikarie.**

| Steg | Gör | Ska höra |
| :-- | :-- | :-- |
| 1.5.1 | Öppna Vikarietavla | Rubrik nivå 1 "Vikarietavla", flikgrupp "Visa" med Dag (vald) och Vecka, datumfält "Datum", knapp "Öppna kalender för Datum" |
| 1.5.2 | Gå till tabellen | Tabell "Lektioner som behöver vikarie …". Varje rad har en kryssruta "Välj Bo Ek: 13:00–14:00 · Matematik · 7B", en knapp "Tillsätt vikarie Bo Ek: …" och en knapp "Fler val Bo Ek: …". |
| 1.5.3 | Välj "Tillsätt vikarie" och sedan en kandidat | En dialog med namn öppnas. När du har valt sägs "Vikarie tillsatt", och fokus är inte förlorat. |

## 2. Lärare

| Steg | Gör | Ska höra |
| :-- | :-- | :-- |
| 2.1 | Öppna Mitt schema | Rubrik nivå 1 "Mitt schema", knapp "Föregående vecka", "Vecka 42", knapp "Nästa vecka", knapp "Denna vecka" (inaktiv) |
| 2.2 | Gå igenom lektionerna | Varje lektion med dag och tid: "Måndag 08:10–09:10, Svenska 7A Sal 101". En inställd lektion säger "Inställd" efter tiden. Ett vikariepass säger "Vikarie". |
| 2.3 | Välj "Nästa vecka" | "Vecka 43" sägs utan att du flyttar dig |
| 2.4 | Gå till Närvaro och öppna en lektion | Rubrik nivå 1 med ämnet, dag och tid, rubrik nivå 2 "Elever" och knappen "Markera alla närvarande" |
| 2.5 | Gå igenom eleverna | En radioknappsgrupp per elev, med elevens namn ("Jamal Sjö"). Knapparna heter Närvarande, Sen, Frånvarande och Anmäld frånvaro. En elev som är anmäld frånvarande säger det före gruppen. |
| 2.6 | Välj ett alternativ med piltangenterna och välj "Spara närvaro" | "Närvaro sparad" |
| 2.7 | Öppna Vikariepass och frånvaro | Rubrikerna "Mina vikariepass" och "Min frånvaro". Varje frånvaro har knappar som säger vilken period de gäller, till exempel "Återkalla ons 14 okt". |
| 2.8 | Välj "Anmäl frånvaro" | En dialog med rubrik, fokus i första fältet, fält med namn. När du skickar sägs "Frånvaron är registrerad". |
| 2.9 | Öppna Ledighet, mentorns inkorg | Rubrik nivå 1 "Ledighet" och flikgruppen Väntar, Beviljad, Avslagen. Varje ansökan läses med elevens namn, klass, period, antal skoldagar och vem som beslutar. Knapparna "Bevilja", "Avslå" och "Skicka till rektor" säger vilken elev de gäller. |

## 3. Elev

| Steg | Gör | Ska höra |
| :-- | :-- | :-- |
| 3.1 | Öppna Mitt schema | Som för läraren (2.1–2.3), med klassens lektioner |
| 3.2 | Öppna Min närvaro | Rubrik nivå 1 "Min närvaro", ett meddelande om vad som är gallrat, närvarograden och en tabell "Din närvaro per lektion: dag, tid, ämne och status" |
| 3.3 | Gå igenom tabellen | Kolumnrubrikerna Datum, Tid, Ämne och Status läses med varje cell |

## 4. Vårdnadshavare

| Steg | Gör | Ska höra |
| :-- | :-- | :-- |
| 4.1 | Öppna Mina barn | Rubrik nivå 1 "Mina barn", rubrik nivå 2 "Schema för Ella", flikgrupp "Visa" med I dag (vald) och Vecka, gruppen "Välj barn" med knapparna Ella (nedtryckt) och Hugo |
| 4.2 | Gå igenom dagens lektioner | Rubrik nivå 3 med dag och datum, och en lista: "08:10–09:10 Engelska Sal 101 · Anna Lind", rasten och lunchen. En inställd lektion säger "Inställd", en lektion med vikarie säger "Vikarie". |
| 4.3 | Välj Hugo | Hugos schema visas, och rubriken blir "Schema för Hugo" |
| 4.4 | Anmäl frånvaro | Under rubrik nivå 2 "Anmäl frånvaro" finns fälten Barn (kombinationsruta), Datum (med knappen "Öppna kalender för Datum"), Orsak, Heldag (växlingsknapp, på) och "Anteckning (valfritt)". När du skickar sägs "Frånvaro anmäld". |
| 4.5 | Öppna datumväljaren och välj ett datum med piltangenterna | En dialog "Välj datum" med knappar för föregående och nästa månad. Dagarna läses med hela datumet. Escape stänger dialogen med fokus tillbaka på knappen. |
| 4.6 | Ansök om ledighet | Fälten Barn, Från, Till och Anledning. "Skicka ansökan" är inaktiv tills de är ifyllda. Efteråt sägs "Ledighetsansökan skickad". |
| 4.7 | Välj notisklockan | Knappen heter "Notiser, 2 olästa". En meny öppnas. Pil ned går genom "Markera alla som lästa", varje notis (en oläst börjar med "Oläst.") och "Välj vad som skickas till dig". Escape stänger menyn med fokus tillbaka på klockan. |
| 4.8 | Öppna Notiser | Rubrik nivå 1 "Notiser". En växlingsknapp per notistyp med namn och läge. En som inte går att stänga av är inaktiv och säger varför ("Skickas alltid …"). |

## 5. Alla roller: mobilbredd och tillgänglighetsredogörelsen

Gör det här med VoiceOver på iPhone, eller i en smal webbläsare.

| Steg | Gör | Ska höra |
| :-- | :-- | :-- |
| 5.1 | Välj "Öppna meny" i sidhuvudet | En dialog "Huvudmeny" öppnas, och fokus står på "Stäng". Svep eller Tabb stannar i dialogen. |
| 5.2 | Tryck Escape eller välj "Stäng" | Dialogen stängs, och fokus går tillbaka till "Öppna meny" |
| 5.3 | Öppna en tabell som är bredare än skärmen (till exempel Personer) | Tabellen går att nå med Tabb, och piltangenterna rullar den i sidled |
| 5.4 | Öppna Tillgänglighetsredogörelse | Rubrik nivå 1 "Tillgänglighetsredogörelse för SchemaPro", rubriker nivå 2 och 3 i den ordning Diggs mall har dem, och länken "göra en anmälan till Digg" |

## Efter testet

1. Spara protokollen och inspelningarna där huvudmannen sparar sitt tillgänglighetsarbete. Lägg dem inte i kodförrådet, som är publikt.
2. Gör ett ärende för varje avvikelse, med steg, skärmläsare, webbläsare och tid i inspelningen.
3. Uppdatera tillgänglighetsredogörelsen (`web/app/[locale]/tillganglighet/statement.ts`). Stryk punkten om att skärmläsartestet återstår, eller ersätt den med de brister testet hittade. Ändra datumen för senaste bedömning och senaste uppdatering. Skriv sedan om dokumentet med kommandot nedan (där `[locale]` ingår i sökvägen).

```bash
UPDATE_STATEMENT=1 npx vitest run "app/[locale]/tillganglighet"
```

4. Om en skärm i manuset ändras: kör `npx playwright test --project=a11y e2e/aria.spec.ts --update-snapshots` i `web/` och granska skillnaden i `web/e2e/aria-baselines/` som kod.
