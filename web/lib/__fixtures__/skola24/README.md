# Fixtures för Skola24-beskrivningarna (X3)

Syntetiska filer. Ingen rad är en verklig person: namnen är påhittade, e-postadresserna slutar på
`example.invalid` och personnumren har formen av ett personnummer men börjar på ÅÅÅÅ 1900 (eller ÅÅ 00),
så att ingen verklig person kan ha dem.

Varje fixtur är gjord ur vad EN offentlig sida säger om filen, inte ur en fil från en skola:
kolumnernas ordning, avgränsaren och om en rubrikrad finns. Källan står i `web/lib/skola24-formats.ts`.

| Fil | Beskrivning |
|---|---|
| `foraldrar.csv` | `skola24-foraldrar-csv` (utan rubrikrad; en rad slutar efter kolumn 4, en efter kolumn 6 med tomma e-post och mobil, en har mobilnummer 0701234567) |
| `personal.csv` | `skola24-personal-csv` (utan rubrikrad; sista raden har sekretessmarkering 1) |
| `barn.csv` | `skola24-barn-csv` (sista raden har sekretessmarkering 1) |
| `elever-klass.tsv` | `skola24-elever-klass` (tabbseparerad, med rubrikrad) |
| `extens-franvaro.txt` | `skola24-extens-franvaro` (utan rubrikrad) |

När en riktig fil kommer: pseudonymisera den (X1), lägg den här, och fyll i beskrivningen. En fil som skolan har
skickat hit är aldrig en fixtur utan att den först gjorts om till påhittade värden.
