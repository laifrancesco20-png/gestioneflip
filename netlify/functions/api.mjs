import { getStore } from "@netlify/blobs";
import { createApp } from "../../lib/app.mjs";

// Su Netlify i dati stanno in Netlify Blobs.
export const config = { path: "/api/*" };

export default createApp(() => getStore("fip-silver"));
