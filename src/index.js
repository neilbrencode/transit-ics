// Transit alerts -> iCalendar feeds (Cloudflare Worker, no dependencies)
//
// GET /transit.ics  Sound Transit alerts (src/st.js)
// GET /wsf.ics      Washington State Ferries alerts (src/wsf.js)

import { handleTransit } from "./st.js";
import { handleFerries } from "./wsf.js";

export { buildCalendar } from "./st.js";

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    if (url.pathname === "/transit.ics") return handleTransit(url);
    if (url.pathname === "/wsf.ics") return handleFerries(url, env);
    return new Response("Not found", { status: 404 });
  },
};
