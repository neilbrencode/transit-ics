// Transit alerts -> iCalendar feeds (Cloudflare Worker, no dependencies)
//
// GET /transit.ics  Sound Transit alerts (src/st.js)

import { handleTransit } from "./st.js";

export { buildCalendar } from "./st.js";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/transit.ics") return handleTransit(url);
    return new Response("Not found", { status: 404 });
  },
};
