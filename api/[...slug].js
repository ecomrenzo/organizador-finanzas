import { createApiHandler } from '../lib/handler.js';
import { getDb } from '../lib/firebase.js';

// Vercel Node.js function. JSON bodies arrive on req.body when
// Content-Type is application/json. Deployment Protection is enforced
// by Vercel before this runs; callers send x-vercel-protection-bypass.
const handler = createApiHandler({ getDb });

export { createApiHandler };
export default handler;
