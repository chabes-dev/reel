/* Reel on Cloudflare: the page and icons are served as static files from the repo root
   (.assetsignore keeps server code out), and /api/* runs here with the same endpoints as the
   Vercel version. Storage is the shared D1 database "study-apps" (see store.js). */
import { useDB } from './store.js';
import * as library from './library.js';
import * as thumb from './thumb.js';
import * as usage from './usage-route.js';
import * as enrich from './enrich.js';
import * as team from './team.js';

const ROUTES = { '/api/library': library, '/api/thumb': thumb, '/api/usage': usage, '/api/enrich': enrich, '/api/team': team };

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const mod = ROUTES[path];
    if (!mod) {
      if (path.startsWith('/api/')) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
      return env.ASSETS.fetch(request);
    }
    const handler = mod[request.method];
    if (!handler) return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers: { 'content-type': 'application/json' } });
    useDB(env.DB);
    try {
      return await handler(request);
    } catch (e) {
      return new Response(JSON.stringify({ error: String((e && e.message) || e).slice(0, 300) }), { status: 500, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
  },
};
