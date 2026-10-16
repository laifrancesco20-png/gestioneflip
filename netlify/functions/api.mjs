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

// Gli account stanno in Blobs ("config/users"), con il codice salvato solo come hash.
// Al primo avvio vengono creati da ACCESS_CODES = {"<codice>": "<nome>", ...};
// l'amministratore è chi è elencato in ADMIN_NAMES (nomi separati da virgola) o, in mancanza, il primo.
const USERS_KEY = "config/users";
const ROLES = ["admin", "membro", "servizio"];

async function hashCode(code) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newCode() {
  return [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function accessMap() {
  try {
    return JSON.parse(process.env.ACCESS_CODES || "{}");
  } catch {
    console.error("ACCESS_CODES non è un JSON valido.");
    return {};
  }
}

async function loadUsers(store) {
  const saved = await store.get(USERS_KEY, { type: "json" });
  if (saved?.users) return saved.users;

  const entries = Object.entries(accessMap());
  if (!entries.length) {
    console.error("Nessun account salvato e ACCESS_CODES non impostata: nessuno può accedere.");
    return [];
  }
  const admins = (process.env.ADMIN_NAMES || "").split(",").map((n) => n.trim()).filter(Boolean);
  const now = new Date().toISOString();
  const users = await Promise.all(
    entries.map(async ([code, name], i) => ({
      id: crypto.randomUUID(),
      name: clean(name, 80).trim(),
      hash: await hashCode(code),
      role: (admins.length ? admins.includes(name) : i === 0) ? "admin" : "membro",
      createdAt: now,
      createdBy: "configurazione iniziale",
    })),
  );
  await store.setJSON(USERS_KEY, { users });
  return users;
}

async function userForCode(users, code) {
  if (!code) return null;
  const hash = await hashCode(code);
  return users.find((u) => u.hash === hash) || null;
}

// Le persone che compaiono negli elenchi (responsabili, calendario): niente account di servizio.
const peopleOf = (users) => [...new Set(users.filter((u) => u.role !== "servizio").map((u) => u.name))].sort();
const publicUser = ({ id, name, role, createdAt, createdBy }) => ({ id, name, role, createdAt, createdBy });

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
    "in un giorno e orario se ha un evento 'indisponibile' che si sovrappone, o se c'è una 'riunione' nello stesso orario. " +
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

const SEEN_PREFIX = "seen/";
const MAX_BATCH = 300;

// Versione dei documenti già vista da ciascuno: {"<id documento>": <versione>}.
// La prima volta parte da "tutto visto", così all'arrivo della funzione non risulta tutto nuovo.
async function loadSeen(store, user, docs) {
  const saved = await store.get(SEEN_PREFIX + user.id, { type: "json" });
  if (saved) return saved;
  const seen = Object.fromEntries(docs.map((d) => [d.id, d.version || 1]));
  await store.setJSON(SEEN_PREFIX + user.id, seen);
  return seen;
}

async function markSeen(store, user, entries) {
  if (!entries.length) return;
  const seen = (await store.get(SEEN_PREFIX + user.id, { type: "json" })) || {};
  for (const [id, version] of entries) seen[id] = Math.max(seen[id] || 0, version);
  await store.setJSON(SEEN_PREFIX + user.id, seen);
}

const validId = (id) => typeof id === "string" && /^[\w-]{1,80}$/.test(id);

// Crea o aggiorna un elemento. Con merge=true i campi mancanti restano quelli già salvati.
async function upsert(store, name, { collection, id, data, merge }) {
  if (!COLLECTIONS.includes(collection)) throw new HttpError(400, "Collezione non valida.");
  if (id !== undefined && id !== null && id !== "" && !validId(id)) throw new HttpError(400, "Id non valido.");
  const finalId = id || crypto.randomUUID();
  const key = `${collection}/${finalId}`;
  const previous = await store.get(key, { type: "json" });
  const input = merge && previous ? { ...previous, ...(data || {}) } : data;
  const fields = sanitize(collection, input);
  if (collection !== "notes" && !fields.title) throw new HttpError(400, "Il titolo è obbligatorio.");
  const now = new Date().toISOString();
  const record = {
    ...fields,
    createdBy: previous?.createdBy || name,
    createdAt: previous?.createdAt || now,
    updatedBy: name,
    updatedAt: now,
  };
  await store.setJSON(key, record);
  return { id: finalId, ...record };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "");

  try {
    const store = getStore("fip-silver");
    const users = await loadUsers(store);

    if (route === "login" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const user = await userForCode(users, clean(body.code, 200).trim());
      if (!user) return json(401, { error: "Codice non riconosciuto." });
      return json(200, { name: user.name, isAdmin: user.role === "admin" });
    }

    const me = await userForCode(users, (req.headers.get("x-code") || "").trim());
    if (!me) return json(401, { error: "Accesso non valido. Rientra con il tuo codice." });
    const name = me.name;
    const isAdmin = me.role === "admin";

    if (route === "state" && req.method === "GET") {
      const [tasks, docs, events, notes] = await Promise.all(COLLECTIONS.map((c) => readItems(store, c)));
      const seen = await loadSeen(store, me, docs);
      const byDate = (a, b) => (a.date || "").localeCompare(b.date || "") || (a.start || "").localeCompare(b.start || "");
      return json(200, {
        me: name,
        isAdmin,
        people: peopleOf(users),
        tasks,
        docs,
        events: events.sort(byDate),
        notes: notes.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")),
        seen,
      });
    }

    if (route === "item" && req.method === "PUT") {
      const body = await req.json().catch(() => ({}));
      const item = await upsert(store, name, body);
      if (body.collection === "docs") await markSeen(store, me, [[item.id, item.version]]);
      return json(200, item);
    }

    if (route === "item" && req.method === "DELETE") {
      const collection = url.searchParams.get("collection");
      const id = url.searchParams.get("id") || "";
      if (!COLLECTIONS.includes(collection) || !validId(id)) return json(400, { error: "Richiesta non valida." });
      await store.delete(`${collection}/${id}`);
      return json(200, { ok: true });
    }

    // Più modifiche in una volta (caricamenti iniziali, modifiche fatte da Claude).
    // ops: [{action: "put", collection, id?, data, merge?} | {action: "delete", collection, id}]
    if (route === "batch" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const ops = Array.isArray(body.ops) ? body.ops : [];
      if (!ops.length || ops.length > MAX_BATCH) return json(400, { error: `Servono da 1 a ${MAX_BATCH} operazioni.` });
      const results = [];
      const seenDocs = [];
      for (const [i, op] of ops.entries()) {
        try {
          if (op?.action === "delete") {
            if (!COLLECTIONS.includes(op.collection) || !validId(op.id)) throw new HttpError(400, "Richiesta non valida.");
            await store.delete(`${op.collection}/${op.id}`);
            results.push({ i, ok: true, id: op.id });
          } else if (op?.action === "put") {
            const item = await upsert(store, name, op);
            if (op.collection === "docs") seenDocs.push([item.id, item.version]);
            results.push({ i, ok: true, id: item.id });
          } else {
            throw new HttpError(400, "Azione non valida: usa put o delete.");
          }
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          results.push({ i, ok: false, error: err.message });
        }
      }
      await markSeen(store, me, seenDocs);
      return json(200, { results });
    }

    if (route === "seen" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (!validId(body.id)) return json(400, { error: "Richiesta non valida." });
      const doc = await store.get(`docs/${body.id}`, { type: "json" });
      if (!doc) return json(404, { error: "Documento non trovato." });
      await markSeen(store, me, [[body.id, doc.version || 1]]);
      return json(200, { ok: true });
    }

    if (route === "users" || route.startsWith("users/")) {
      if (!isAdmin) return json(403, { error: "Solo l'amministratore può gestire gli account." });
      const save = (list) => store.setJSON(USERS_KEY, { users: list });

      if (route === "users" && req.method === "GET") {
        return json(200, { users: users.map(publicUser) });
      }

      if (route === "users" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const newName = clean(body.name, 80).trim().replace(/\s+/g, " ");
        if (!newName) return json(400, { error: "Scrivi nome e cognome." });
        if (users.some((u) => u.name.toLowerCase() === newName.toLowerCase())) {
          return json(400, { error: "Esiste già un account con questo nome." });
        }
        const code = newCode();
        const user = {
          id: crypto.randomUUID(),
          name: newName,
          hash: await hashCode(code),
          role: pick(body.role, ROLES, "membro"),
          createdAt: new Date().toISOString(),
          createdBy: name,
        };
        await save([...users, user]);
        return json(200, { user: publicUser(user), code });
      }

      const id = url.searchParams.get("id") || "";
      const target = users.find((u) => u.id === id);
      if (!target) return json(404, { error: "Account non trovato." });

      if (route === "users/code" && req.method === "POST") {
        const code = newCode();
        const hash = await hashCode(code);
        await save(users.map((u) => (u.id === id ? { ...u, hash } : u)));
        return json(200, { user: publicUser(target), code });
      }

      if (route === "users" && req.method === "DELETE") {
        if (target.id === me.id) return json(400, { error: "Non puoi eliminare il tuo account." });
        await save(users.filter((u) => u.id !== id));
        await store.delete(SEEN_PREFIX + id);
        return json(200, { ok: true });
      }
    }

    if (route === "ai" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const [tasks, docs, events, notes] = await Promise.all(COLLECTIONS.map((c) => readItems(store, c)));
      const answer = await askGemini(body.question, Array.isArray(body.history) ? body.history : [], {
        organizzatori: peopleOf(users),
        tasks,
        docs,
        events,
        notes,
      });
      return json(200, { answer });
    }

    return json(404, { error: "Percorso non trovato." });
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message });
    console.error(err);
    return json(500, { error: err.message || "Errore del server." });
  }
};
