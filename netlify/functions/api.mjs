import { getStore } from "@netlify/blobs";

// Un solo store per il torneo. Ogni elemento è una chiave "<collezione>/<id>":
// così due persone che modificano cose diverse non si sovrascrivono a vicenda.
const COLLECTIONS = ["tasks", "docs", "events", "notes"];
const MAX_TEXT = 2000;

export const config = { path: "/api/*" };

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// ACCESS_CODES = {"<codice personale>": "<nome>", ...} impostata nelle variabili d'ambiente di Netlify.
function accessMap() {
  try {
    const map = JSON.parse(process.env.ACCESS_CODES || "{}");
    if (!Object.keys(map).length) console.error("ACCESS_CODES non impostata: nessuno può accedere.");
    return map;
  } catch {
    console.error("ACCESS_CODES non è un JSON valido.");
    return {};
  }
}

function nameForCode(code) {
  const map = accessMap();
  if (!code || !Object.prototype.hasOwnProperty.call(map, code)) return null;
  return map[code];
}

function clean(value, max = MAX_TEXT) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

// Accetta solo i campi previsti per ciascuna collezione.
function sanitize(collection, input) {
  const d = input && typeof input === "object" ? input : {};
  const s = (key, max = 200) => clean(d[key], max).trim();
  switch (collection) {
    case "tasks":
      return {
        title: s("title"),
        owner: s("owner", 80),
        due: s("due", 10),
        status: pick(d.status, ["todo", "doing", "done"], "todo"),
        notes: s("notes"),
      };
    case "docs": {
      const history = Array.isArray(d.history)
        ? d.history.slice(-100).map((h) => ({
            version: Math.max(1, Math.floor(Number(h?.version) || 1)),
            by: clean(h?.by, 80),
            at: clean(h?.at, 40),
            note: clean(h?.note, 500),
          }))
        : [];
      return {
        title: s("title"),
        owner: s("owner", 80),
        status: pick(d.status, ["bozza", "da_confermare", "confermato", "inviato"], "bozza"),
        version: Math.max(1, Math.floor(Number(d.version) || 1)),
        link: s("link", 500),
        history,
      };
    }
    case "events":
      return {
        title: s("title"),
        person: s("person", 80),
        kind: pick(d.kind, ["indisponibile", "riunione"], "indisponibile"),
        date: s("date", 10),
        start: s("start", 5),
        end: s("end", 5),
        notes: s("notes"),
      };
    case "notes":
      return { title: s("title"), text: clean(d.text) };
    default:
      return null;
  }
}

async function readItems(store, collection) {
  const { blobs } = await store.list({ prefix: collection + "/" });
  const items = await Promise.all(
    blobs.map(async ({ key }) => {
      const item = await store.get(key, { type: "json" });
      return item ? { id: key.slice(collection.length + 1), ...item } : null;
    }),
  );
  return items.filter(Boolean);
}

async function askGemini(question, history, snapshot) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Chiave Gemini non configurata sul server.");
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const today = new Date().toISOString().slice(0, 10);
  const system =
    "Sei l'assistente del gruppo di organizzatori del torneo FIP Silver Alghero 2027. " +
    "Rispondi in italiano, in modo breve e concreto. Usa solo i dati dello STATO qui sotto. " +
    "Se un dato non c'è, dillo chiaramente. Per la disponibilità: una persona è occupata " +
    "in un giorno e orario se ha un evento 'indisponibile' che si sovrappone, e ha un 'riunione' nello stesso orario. " +
    `Oggi è ${today}.\n\nSTATO:\n${JSON.stringify(snapshot)}`;

  const contents = history
    .slice(-10)
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: clean(m.text, 4000) }] }))
    .filter((m, i, arr) => !(i === 0 && m.role === "model"));
  contents.push({ role: "user", parts: [{ text: clean(question, 4000) }] });

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Gemini ha risposto ${res.status}`);
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("");
  return text || "Nessuna risposta dal modello.";
}

export default async (req) => {
  const route = new URL(req.url).pathname.replace(/^\/api\/?/, "");
  const url = new URL(req.url);

  try {
    if (route === "login" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const name = nameForCode(clean(body.code, 200).trim());
      if (!name) return json(401, { error: "Codice non riconosciuto." });
      return json(200, { name });
    }

    const name = nameForCode((req.headers.get("x-code") || "").trim());
    if (!name) return json(401, { error: "Accesso non valido. Rientra con il tuo codice." });

    const store = getStore("fip-silver");

    if (route === "state" && req.method === "GET") {
      const [tasks, docs, events, notes] = await Promise.all(COLLECTIONS.map((c) => readItems(store, c)));
      const people = [...new Set(Object.values(accessMap()))].sort();
      const byDate = (a, b) => (a.date || "").localeCompare(b.date || "") || (a.start || "").localeCompare(b.start || "");
      return json(200, {
        me: name,
        people,
        tasks,
        docs,
        events: events.sort(byDate),
        notes: notes.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")),
      });
    }

    if (route === "item" && req.method === "PUT") {
      const body = await req.json().catch(() => ({}));
      const collection = body.collection;
      const data = sanitize(collection, body.data);
      if (!COLLECTIONS.includes(collection) || !data) return json(400, { error: "Collezione non valida." });
      if (collection !== "notes" && !data.title) return json(400, { error: "Il titolo è obbligatorio." });

      const now = new Date().toISOString();
      const id = typeof body.id === "string" && body.id ? body.id : crypto.randomUUID();
      const key = `${collection}/${id}`;
      const previous = await store.get(key, { type: "json" });
      const record = {
        ...data,
        createdBy: previous?.createdBy || name,
        createdAt: previous?.createdAt || now,
        updatedBy: name,
        updatedAt: now,
      };
      await store.setJSON(key, record);
      return json(200, { id, ...record });
    }

    if (route === "item" && req.method === "DELETE") {
      const collection = url.searchParams.get("collection");
      const id = url.searchParams.get("id") || "";
      if (!COLLECTIONS.includes(collection) || !/^[\w-]{1,80}$/.test(id)) {
        return json(400, { error: "Richiesta non valida." });
      }
      await store.delete(`${collection}/${id}`);
      return json(200, { ok: true });
    }

    if (route === "ai" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const [tasks, docs, events, notes] = await Promise.all(COLLECTIONS.map((c) => readItems(store, c)));
      const answer = await askGemini(body.question, Array.isArray(body.history) ? body.history : [], {
        tasks,
        docs,
        events,
        notes,
      });
      return json(200, { answer });
    }

    return json(404, { error: "Percorso non trovato." });
  } catch (err) {
    console.error(err);
    return json(500, { error: err.message || "Errore del server." });
  }
};
