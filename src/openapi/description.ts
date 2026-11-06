import { AREA_LABELS, PROFILE_LABELS } from '../auth/admin-areas';
import { EnvironmentVariables } from '../config/env.validation';
import { SCHOOL_HEADER } from '../auth/school-choice';

/**
 * The prose of the OpenAPI document (info.description and the pieces the
 * operations point to). Written in Swedish with the standards' own English
 * words kept (Bearer, JWT, ISO 8601, UUID, the header names), and an English
 * summary at the end for tools and readers who stop at the first language.
 *
 * What can be read from the code is read from it, so that the text and the
 * gateway change together: the administrator profiles and areas from
 * src/auth/admin-areas.ts, the school header from src/auth/school-choice.ts,
 * the default rate limit from the environment schema. The rest is stated here
 * and kept true by a test over the document (test/openapi-document.openapi-spec.ts).
 */

/** The header that names the school, as the clients write it. */
export const SCHOOL_HEADER_NAME = 'X-School-Id';

const profiles = Object.values(PROFILE_LABELS)
  .map((label) => `**${label}**`)
  .join(', ');
const areas = Object.values(AREA_LABELS)
  .map((label) => `**${label}**`)
  .join(', ');
const defaults = new EnvironmentVariables();

if (SCHOOL_HEADER_NAME.toLowerCase() !== SCHOOL_HEADER) {
  throw new Error(`The documented school header ${SCHOOL_HEADER_NAME} is not the gateway's (${SCHOOL_HEADER}).`);
}

export const API_DESCRIPTION = `
Rastras API för skolans administratörer och för Rastras egna klienter (webben och appen): alla routes under \`/api/v1\`. Beskrivningen är genererad ur gatewayens controllers och DTO-klasser, så att den följer koden; \`docs/api/openapi.json\` i repot är samma dokument.

## Vad som ingår, och vad som inte gör det

- **Ingår:** varje route under \`/api/v1\`.
- **Ingår inte:** SS12000-leverantörerna \`/ss12000/v1\` och \`/ss12000/v2.0\` (de nås med en integrationsnyckel, \`X-API-Key: sp_…\`, och beskrivs i \`docs/integration-api.md\`), de publika routerna under \`/public/v1\` (Schemavisaren, kalenderprenumerationen och inloggningsmetoderna, som nås utan inloggning) och hälsoproberna \`/health\`.

Integrationsnycklar godtas **inte** på \`/api/v1\`.

## Inloggning

Varje anrop bär \`Authorization: Bearer <JWT>\`: den åtkomsttoken som inloggningstjänsten (Supabase) gav personen. Gatewayen verifierar den mot tjänstens publika nycklar och slår upp personens roll hos skolan. Utan giltig token svarar gatewayen 401.

Ett konto kan ha en roll på flera skolor. Skolan anges då med headern \`${SCHOOL_HEADER_NAME}: <skolans UUID>\`; utan den gäller kontots första aktiva roll. Ett skol-id som kontot saknar aktiv roll på ger 403 (\`SCHOOL_NOT_AVAILABLE\`) och ett värde som inte är ett UUID ger 400 (\`SCHOOL_ID_INVALID\`). Valet väljer bara bland kontots egna roller och är ingen behörighet.

Vem som får anropa en route står på varje operation i \`x-roles\`. En administratör har dessutom en profil (${profiles}) som avgör vilka områden hen får ändra (${areas}); en skrivande route anger sina områden i \`x-admin-write\`, och \`decides: true\` betyder att den kräver rektor eller en fullständig administratör. Att läsa är alla administratörers. Databasen håller samma gränser med radnivåsäkerhet (row-level security) under gatewayen, så ett anrop ser bara raderna för den skola det gäller.

## Format

- Datum skrivs \`ÅÅÅÅ-MM-DD\` och tidpunkter som ISO 8601 i UTC (\`2026-09-01T08:15:00.000Z\`). Klockslag inom en skoldag skrivs \`HH:MM\`.
- Id är UUID.
- Förfrågningar och svar är JSON (\`application/json\`), med de undantag som en operation anger. Förfrågningskroppar får vara högst 1 MB.
- Anger en förfrågan ett fält som beskrivningen inte känner, eller ett värde som inte uppfyller fältets regler, svarar gatewayen 400.

## Läsloggen

Varje läsning av personuppgifter skrivs till läsloggen (vem läste vems uppgifter, när och via vilken klient), i samma transaktion som läsningen: kan loggen inte skrivas misslyckas läsningen. Skolans administratör ser loggen under Dataskydd, och \`GET /api/v1/access-log\` är den route som läser den; även den läsningen loggas.

## Hastighetsbegränsning

Gatewayen begränsar anropen per klientadress. Standardvärdet är ${defaults.THROTTLE_LIMIT} anrop per ${defaults.THROTTLE_TTL_SECONDS} sekunder; driftmiljön kan sätta ett annat. Vissa routes har en egen, strängare gräns, som står i \`x-rate-limit\` på operationen. Överskrids den svarar gatewayen 429 med \`Retry-After\`; svaren bär \`X-RateLimit-Limit\`, \`X-RateLimit-Remaining\` och \`X-RateLimit-Reset\`.

## Fel

Alla fel har samma form, \`application/problem+json\` enligt RFC 7807 (schemat \`Problem\`): \`type\`, \`title\`, \`status\`, \`detail\`, \`instance\` (sökvägen) och \`traceId\` (ett id som loggen kan matchas mot), och vid behov \`errors\` (fältvisa valideringsfel), \`code\` (ett maskinläsbart namn att förgrena på) och \`params\` (värdena i kodens mening). Interna detaljer, stackspår och SQL lämnar aldrig gatewayen.

## Svar

Förfrågningskroppar och frågeparametrar beskrivs ur DTO-klasserna, med deras regler (gränser, format, uppräkningar). Svar beskrivs som JSON-objekt: de är i regel databasens rader eller tjänsternas sammanställningar och har ingen egen klass att läsa ett schema ur. Ett lyckat svar utan \`content\` är ett svar vars innehåll beskrivningen inte säger något om, för att routen saknar typad returtyp (204 är svaret utan innehåll). En route som svarar med en fil (den sätter Content-Disposition eller skriver svaret själv) anges som en fil, \`format: binary\`, och inte som JSON.

## English summary

Rastra's administration API: every route under \`/api/v1\`, generated from the gateway's controllers and DTO classes. Authentication is a Supabase JWT as a Bearer token; the school is chosen with the \`${SCHOOL_HEADER_NAME}\` header when a login has roles at several schools. Dates are ISO 8601, ids are UUIDs, errors are RFC 7807 \`application/problem+json\`, and every read of personal data is written to the access log (läslogg). Not covered: the SS12000 providers (\`/ss12000/*\`, integration key), the public routes (\`/public/v1/*\`) and the health probes.
`.trim();

/** The security scheme of the bearer token. */
export const BEARER_DESCRIPTION =
  'Åtkomsttoken (JWT) från inloggningstjänsten, i headern `Authorization: Bearer <token>`. Gäller varje route i dokumentet.';

/** The optional header that names the school. */
export const SCHOOL_PARAMETER_DESCRIPTION =
  'Skolan anropet gäller (skolans UUID), för ett konto med roll på flera skolor. Utan headern gäller kontots första aktiva roll. Ett skol-id kontot saknar aktiv roll på ger 403 `SCHOOL_NOT_AVAILABLE`; ett värde som inte är ett UUID ger 400 `SCHOOL_ID_INVALID`.';
