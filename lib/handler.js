import { authorize } from './auth.js';
import { COLLECTIONS, DEFAULT_CATEGORIES, isValidId } from './defaults.js';
import {
  categoryNameTaken,
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  updateDocument,
} from './repo.js';
import { normalizeCreate, normalizeUpdate, parseListQuery } from './validate.js';

function reply(status, body, headers = {}) {
  return {
    status,
    body,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  };
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);
}

function readBody(req) {
  const body = req.body;
  if (body == null || body === '') return { ok: true, value: {} };
  if (Buffer.isBuffer(body)) {
    if (body.length === 0) return { ok: true, value: {} };
    try {
      return { ok: true, value: JSON.parse(body.toString('utf8')) };
    } catch {
      return { ok: false, error: 'Invalid JSON' };
    }
  }
  if (typeof body === 'string') {
    try {
      return { ok: true, value: JSON.parse(body) };
    } catch {
      return { ok: false, error: 'Invalid JSON' };
    }
  }
  if (typeof body === 'object') return { ok: true, value: body };
  return { ok: false, error: 'Invalid JSON' };
}

function requestUrl(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  if (req.query && typeof req.query === 'object') {
    for (const [key, raw] of Object.entries(req.query)) {
      if (key === 'slug') continue;
      if (url.searchParams.has(key)) continue;
      const values = Array.isArray(raw) ? raw : [raw];
      for (const value of values) {
        if (value != null) url.searchParams.append(key, String(value));
      }
    }
  }
  return url;
}

function segmentsOf(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'api') parts.shift();
  return parts;
}

function safeError(err) {
  const message = err instanceof Error ? err.message : 'error';
  return message.replace(/-----BEGIN[\s\S]*?-----END[^-]+-----/g, '[redacted]').slice(0, 300);
}

export async function handleRequest(req, deps) {
  const headers = req.headers || {};
  const auth = authorize(headers.authorization || headers.Authorization, deps.token);
  if (!auth.ok) return reply(auth.status, { error: auth.error });

  const url = requestUrl(req);
  const segments = segmentsOf(url);
  if (segments.length < 1 || segments.length > 2) return reply(404, { error: 'Not found' });

  const [collection, id] = segments;
  if (!COLLECTIONS.includes(collection)) {
    return reply(404, {
      error: 'Unknown collection. Use transactions, debts, subscriptions, events, or categories.',
    });
  }
  if (id !== undefined && !isValidId(id)) return reply(400, { error: 'Invalid id' });

  const method = String(req.method || 'GET').toUpperCase();
  const now = deps.now ? deps.now() : new Date();

  try {
    if (!id && method === 'GET') return await list(deps.db, collection, url);
    if (!id && method === 'POST') return await create(deps.db, collection, readBody(req), { now });
    if (id && method === 'GET') return await readOne(deps.db, collection, id);
    if (id && method === 'PATCH') return await update(deps.db, collection, id, readBody(req), { now });
    if (id && method === 'DELETE') return await remove(deps.db, collection, id);
  } catch (err) {
    console.error('api error:', safeError(err));
    return reply(500, { error: 'Internal error' });
  }

  const allow = id ? 'GET, PATCH, DELETE' : 'GET, POST';
  return reply(405, { error: 'Method not allowed' }, { Allow: allow });
}

async function list(db, collection, url) {
  const parsed = parseListQuery(collection, url.searchParams);
  if (!parsed.ok) return reply(400, { error: parsed.error });
  const { items, truncated } = await listDocuments(db, collection, parsed.value);
  const body = { items, truncated };
  if (collection === 'categories') body.defaults = DEFAULT_CATEGORIES;
  return reply(200, body);
}

async function create(db, collection, parsedBody, ctx) {
  if (!parsedBody.ok) return reply(400, { error: parsedBody.error });
  const body = parsedBody.value;

  // Same id → same document. A retry returns what was stored and does not write again.
  if (isPlainObject(body) && isValidId(body.id)) {
    const existing = await getDocument(db, collection, body.id);
    if (existing) return reply(200, { item: existing, created: false });
  }

  const normalized = normalizeCreate(collection, body, ctx);
  if (!normalized.ok) return reply(400, { error: normalized.error });

  if (collection === 'categories') {
    const taken = await categoryNameTaken(db, normalized.value.name, normalized.value.id);
    if (taken) return reply(409, { error: 'A category with that name already exists' });
  }

  const result = await createDocument(db, collection, normalized.value);
  return reply(result.created ? 201 : 200, { item: result.item, created: result.created });
}

async function readOne(db, collection, id) {
  const item = await getDocument(db, collection, id);
  if (!item) return reply(404, { error: 'Not found' });
  return reply(200, { item });
}

async function update(db, collection, id, parsedBody, ctx) {
  if (!parsedBody.ok) return reply(400, { error: parsedBody.error });
  if (!isPlainObject(parsedBody.value)) return reply(400, { error: 'Body must be a JSON object' });
  if (Object.keys(parsedBody.value).length === 0) return reply(400, { error: 'Body is empty' });

  const existing = await getDocument(db, collection, id);
  if (!existing) return reply(404, { error: 'Not found' });

  const normalized = normalizeUpdate(collection, existing, parsedBody.value, ctx);
  if (!normalized.ok) return reply(400, { error: normalized.error });

  if (collection === 'categories') {
    const taken = await categoryNameTaken(db, normalized.value.name, id);
    if (taken) return reply(409, { error: 'A category with that name already exists' });
  }

  const result = await updateDocument(db, collection, id, () => ({ ok: true, value: normalized.value }));
  if (!result.found) return reply(404, { error: 'Not found' });
  if (result.error) return reply(400, { error: result.error });
  return reply(200, { item: result.item });
}

async function remove(db, collection, id) {
  const deleted = await deleteDocument(db, collection, id);
  if (!deleted) return reply(404, { error: 'Not found' });
  return reply(200, { deleted: true, id });
}

export function createApiHandler({ getDb, token, now } = {}) {
  return async function handler(req, res) {
    const write = (result) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      for (const [key, value] of Object.entries(result.headers || {})) {
        if (key.toLowerCase() === 'cache-control' || key.toLowerCase() === 'x-content-type-options') continue;
        res.setHeader(key, value);
      }
      res.status(result.status).json(result.body);
    };

    let db;
    try {
      db = await getDb();
    } catch (err) {
      if (err && err.code === 'CONFIG') {
        write({ status: 500, body: { error: err.message }, headers: {} });
        return;
      }
      console.error('api error:', safeError(err));
      write({ status: 500, body: { error: 'Internal error' }, headers: {} });
      return;
    }

    const result = await handleRequest(req, {
      db,
      token: token ?? process.env.API_TOKEN ?? '',
      now,
    });
    write(result);
  };
}
