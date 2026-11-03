import { createApp } from "../lib/app.mjs";
import { redisStore } from "../lib/redis-store.mjs";

// Su Vercel una sola funzione riceve tutte le richieste /api/* (vedi vercel.json).
export default { fetch: createApp(redisStore) };
