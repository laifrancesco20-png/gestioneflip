# FIP Silver Alghero – Coordinamento

App semplice per i 5 organizzatori: compiti, documenti con versione e stato, calendario (indisponibilità e riunioni), note e un assistente AI (Gemini).

## Struttura
- `public/index.html`: l'interfaccia (un solo file, nessuna dipendenza).
- `netlify/functions/api.mjs`: API. Gestisce i codici personali, salva i dati su Netlify Blobs e chiama Gemini lato server, così la chiave non finisce mai nel browser.

## Pubblicazione su Netlify
1. Crea un sito Netlify collegato a questa cartella (o a un repository GitHub con questi file).
2. In Site configuration > Environment variables imposta:
   - `ACCESS_CODES`: JSON con un codice personale per ciascuno, ad esempio `{"codice-di-flai":"Flai","codice-socio-2":"Nome Socio"}`. Serve solo al primo avvio: gli account vengono copiati su Netlify Blobs (codici salvati come hash) e da lì in poi si gestiscono dall'app.
   - `ADMIN_NAMES` (facoltativo): nomi degli amministratori separati da virgola. Se manca, l'amministratore è il primo di `ACCESS_CODES`.
   - `GEMINI_API_KEY`: la chiave creata in Google AI Studio.
   - `GEMINI_MODEL` (facoltativo): default `gemini-2.5-flash`.
3. Fai il deploy. I dati sono su Netlify Blobs, non serve un database a parte.

## Account
L'amministratore (icona in alto a destra) aggiunge ed elimina le persone e genera nuovi codici; il codice si vede una sola volta, al momento della creazione. Gli account "Servizio" (per esempio quello di Claude) leggono e modificano i dati ma non compaiono tra gli organizzatori.

## Documenti "da vedere"
Per ogni persona l'app ricorda quale versione di ciascun documento ha già visto. Quando qualcuno carica una nuova versione, gli altri lo vedono segnalato (in Oggi, nel menu Documenti e sulla scheda) finché non aprono il file o premono "Visto". Il file vive su OneDrive o Drive, quindi chi lo modifica deve premere "Nuova versione".

## API per modifiche in blocco
Con l'header `x-code`:
- `GET /api/state`: tutti i dati.
- `PUT /api/item` `{collection, id?, data, merge?}`: crea o aggiorna una voce (`merge: true` cambia solo i campi passati).
- `DELETE /api/item?collection=&id=`.
- `POST /api/batch` `{ops: [{action: "put", collection, id?, data, merge?} | {action: "delete", collection, id}]}`: fino a 300 operazioni, con l'esito di ciascuna.

Collezioni: `tasks`, `docs`, `events`, `notes`.

## Limiti della versione prototipo
- Le modifiche concorrenti sulla stessa voce: vince l'ultima salvata. L'app si aggiorna da sola ogni 30 secondi.
- Nessun reset password: chi perde il codice se ne fa generare uno nuovo dall'amministratore.
