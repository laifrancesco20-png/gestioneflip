// Dati su Upstash Redis (database collegato al progetto Vercel), tutti in un'unica hash "fip":
// ogni richiesta legge tutto con un solo comando, così si resta nel piano gratuito anche con
// l'app aperta da tutti. Stessa interfaccia di Netlify Blobs: get, setJSON, delete, list.

const HASH = "fip";

function connection() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Database non collegato: crea Upstash for Redis nello Storage del progetto Vercel.");
  return { url: url.replace(/\/$/, ""), token };
}

async function redis(command) {
  const { url, token } = connection();
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`Database: ${data.error || res.status}`);
  return data.result;
}

async function readAll() {
  const flat = (await redis(["HGETALL", HASH])) || [];
  const all = new Map();
  for (let i = 0; i < flat.length; i += 2) {
    try { all.set(flat[i], JSON.parse(flat[i + 1])); } catch { /* valore non leggibile: ignorato */ }
  }
  return all;
}

// Trasloco una tantum: se il database è vuoto e c'è il sito di provenienza (MIGRATE_FROM),
// al primo accesso dell'amministratore copia tutto da lì usando il suo codice.
async function migrateIfEmpty(all, code) {
  const from = process.env.MIGRATE_FROM;
  if (all.size || !from) return all;
  const res = code
    ? await fetch(`${from.replace(/\/$/, "")}/api/export`, { headers: { "x-code": code } })
    : null;
  if (!res || res.status === 401 || res.status === 403) {
    throw new Error("I dati non sono ancora stati trasferiti: deve entrare per primo l'amministratore.");
  }
  if (!res.ok) throw new Error(`Trasloco dei dati non riuscito (${res.status}).`);
  const { entries } = await res.json();
  const keys = Object.keys(entries || {});
  if (!keys.length) return all;
  const fields = keys.flatMap((k) => [k, JSON.stringify(entries[k])]);
  await redis(["HSET", HASH, ...fields]);
  console.log(`Trasloco completato: ${keys.length} voci copiate da ${from}.`);
  return new Map(keys.map((k) => [k, entries[k]]));
}

export async function redisStore(req) {
  const all = await migrateIfEmpty(await readAll(), (req?.headers.get("x-code") || "").trim());
  return {
    async get(key) {
      return all.has(key) ? structuredClone(all.get(key)) : null;
    },
    async setJSON(key, value) {
      await redis(["HSET", HASH, key, JSON.stringify(value)]);
      all.set(key, structuredClone(value));
    },
    async delete(key) {
      await redis(["HDEL", HASH, key]);
      all.delete(key);
    },
    async list({ prefix = "" } = {}) {
      return { blobs: [...all.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
}
