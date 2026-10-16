# FIP Silver Alghero – Coordinamento

App semplice per i 5 organizzatori: compiti, documenti con versione e stato, calendario (indisponibilità e riunioni), note e un assistente AI (Gemini).

## Struttura
- `public/index.html`: l'interfaccia (un solo file, nessuna dipendenza).
- `netlify/functions/api.mjs`: API. Gestisce i codici personali, salva i dati su Netlify Blobs e chiama Gemini lato server, così la chiave non finisce mai nel browser.

## Pubblicazione su Netlify
1. Crea un sito Netlify collegato a questa cartella (o a un repository GitHub con questi file).
2. In Site configuration > Environment variables imposta:
   - `ACCESS_CODES`: JSON con un codice personale per ciascuno, ad esempio `{"codice-di-flai":"Flai","codice-socio-2":"Nome Socio"}`. I codici devono essere casuali e diversi, uno per persona.
   - `GEMINI_API_KEY`: la chiave creata in Google AI Studio.
   - `GEMINI_MODEL` (facoltativo): default `gemini-2.5-flash`.
3. Fai il deploy. I dati sono su Netlify Blobs, non serve un database a parte.

Per generare un codice personale: `node -e "console.log(require('crypto').randomBytes(4).toString('hex'))"`.

## Limiti della versione prototipo
- I codici sono in una variabile d'ambiente: per cambiarne uno bisogna modificare la variabile.
- Le modifiche concorrenti sulla stessa voce: vince l'ultima salvata. L'app si aggiorna da sola ogni 30 secondi.
- Nessun reset password: chi perde il codice lo chiede a chi gestisce il sito.
