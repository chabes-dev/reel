import { timingSafeEqual } from 'node:crypto';

/* Every endpoint needs the passphrase set as REEL_KEY on the Vercel project. */
export function authorized(request) {
  const want = process.env.REEL_KEY || '';
  const got = request.headers.get('x-reel-key') || new URL(request.url).searchParams.get('k') || '';
  if (!want || got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export const denied = () => json({ error: 'wrong or missing passphrase' }, 401);
