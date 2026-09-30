import { authorized, denied, json } from './_auth.js';
import { readUsage, gatewayCredits } from './_usage.js';

export async function GET(request) {
  if (!authorized(request)) return denied();
  const [usage, credits] = await Promise.all([readUsage(), gatewayCredits(request)]);
  return json({ ...usage, credits });
}
