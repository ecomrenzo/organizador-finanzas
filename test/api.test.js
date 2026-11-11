import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { authorize, tokensMatch } from '../lib/auth.js';
import { DEFAULT_CATEGORIES } from '../lib/defaults.js';
import { ConfigError } from '../lib/errors.js';
import { normalizePrivateKey, readFirebaseConfig } from '../lib/firebase.js';
import { createApiHandler, handleRequest } from '../lib/handler.js';
import { createMemoryDb } from './memory-db.js';

const TOKEN = 'test-token-with-enough-length';
const NOW = new Date('2026-11-11T15:04:05.000Z');

function call(db, method, path, { body, token = TOKEN, headers = {}, now = () => NOW } = {}) {
  return handleRequest({
    method,
    url: path,
    headers: { authorization: token ? `Bearer ${token}` : '', ...headers },
    body,
  }, { db, token: TOKEN, now });
}

function expense(overrides = {}) {
  return {
    type: 'expense',
    amount: 1250,
    currency: 'UYU',
    category: 'comida',
    note: 'Disco',
    date: '2026-11-11',
    ...overrides,
  };
}

test('token compare does not throw when lengths differ', () => {
  assert.equal(tokensMatch('short', 'a-much-longer-secret'), false);
  assert.equal(tokensMatch('same-secret', 'same-secret'), true);
  assert.equal(authorize(undefined, TOKEN).status, 401);
  assert.equal(authorize('Basic ' + TOKEN, TOKEN).status, 401);
  assert.equal(authorize('Bearer wrong', TOKEN).status, 401);
  assert.equal(authorize('Bearer ' + TOKEN, TOKEN).ok, true);
  assert.equal(authorize('bearer ' + TOKEN, TOKEN).ok, true);
  assert.equal(authorize('', '').status, 500);
});

test('private key env parsing', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----\n';
  assert.equal(normalizePrivateKey(`"${pem.replace(/\n/g, '\\n')}"`), pem.trim());
  assert.equal(
    readFirebaseConfig({
      FIREBASE_PROJECT_ID: 'finanzas-personales-7b3ea',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    }).mode,
    'emulator',
  );
  const config = readFirebaseConfig({
    FIREBASE_PROJECT_ID: 'finanzas-personales-7b3ea',
    FIREBASE_CLIENT_EMAIL: 'api@finanzas-personales-7b3ea.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: pem,
  });
  assert.equal(config.mode, 'cert');
  assert.equal(config.privateKey, pem.trim());
  assert.throws(
    () => readFirebaseConfig({ FIREBASE_PROJECT_ID: 'finanzas-personales-7b3ea' }),
    ConfigError,
  );
});

test('default categories stay aligned with the UI', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('const DEFAULT_CATS = [');
  const end = html.indexOf('];', start);
  const block = html.slice(start, end);
  const ids = [...block.matchAll(/id:\s*'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(ids, DEFAULT_CATEGORIES.map((cat) => cat.id));
  for (const cat of DEFAULT_CATEGORIES) {
    assert.match(block, new RegExp(`name:\\s*'${cat.name}'`));
    assert.match(block, new RegExp(`icon:\\s*'${cat.icon}'`));
  }
});

test('rejects missing, wrong, and non-bearer credentials', async () => {
  const db = createMemoryDb();
  const missing = await handleRequest({
    method: 'GET',
    url: '/api/transactions',
    headers: {},
  }, { db, token: TOKEN });
  assert.equal(missing.status, 401);

  const wrong = await call(db, 'GET', '/api/transactions', { token: 'nope' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, 'Unauthorized');

  const unconfigured = await handleRequest({
    method: 'GET',
    url: '/api/transactions',
    headers: { authorization: 'Bearer something' },
  }, { db, token: '' });
  assert.equal(unconfigured.status, 500);
});

test('unknown collections and paths are closed', async () => {
  const db = createMemoryDb();
  for (const path of ['/api/accounts', '/api/settings/main', '/api/assets', '/api']) {
    const res = await call(db, 'GET', path);
    assert.equal(res.status, 404, path);
  }
  const badId = await call(db, 'GET', '/api/transactions/bad.id');
  assert.equal(badId.status, 400);
  const escaped = await call(db, 'GET', '/api/transactions/../secrets');
  assert.equal(escaped.status, 404);
});

test('creates an expense in the same shape the UI writes', async () => {
  const db = createMemoryDb();
  const res = await call(db, 'POST', '/api/transactions', { body: expense({ id: 'gmail_18c3abf0e1' }) });
  assert.equal(res.status, 201);
  assert.equal(res.body.created, true);
  assert.deepEqual(Object.keys(res.body.item), ['id', 'amount', 'currency', 'type', 'category', 'note', 'date']);
  assert.deepEqual(res.body.item, {
    id: 'gmail_18c3abf0e1',
    amount: 1250,
    currency: 'UYU',
    type: 'expense',
    category: 'comida',
    note: 'Disco',
    date: '2026-11-11T12:00:00.000Z',
  });
  assert.deepEqual(db._all('transactions'), [res.body.item]);
});

test('a repeated id returns the original document and does not duplicate', async () => {
  const db = createMemoryDb();
  const first = await call(db, 'POST', '/api/transactions', { body: expense({ id: 'gmail_18c3abf0e1' }) });
  const retry = await call(db, 'POST', '/api/transactions', {
    body: expense({ id: 'gmail_18c3abf0e1', amount: 9, note: 'otro' }),
  });
  const brokenRetry = await call(db, 'POST', '/api/transactions', {
    body: { id: 'gmail_18c3abf0e1', amount: '1250' },
  });

  assert.equal(first.status, 201);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.created, false);
  assert.equal(retry.body.item.amount, 1250);
  assert.equal(retry.body.item.note, 'Disco');
  assert.equal(brokenRetry.status, 200);
  assert.equal(brokenRetry.body.item.amount, 1250);
  assert.equal(db._all('transactions').length, 1);
});

test('generated ids are prefixed like the UI and two creates stay distinct', async () => {
  const db = createMemoryDb();
  const withoutDate = expense();
  delete withoutDate.date;
  const a = await call(db, 'POST', '/api/transactions', { body: withoutDate });
  const b = await call(db, 'POST', '/api/transactions', { body: expense({ note: 'otro' }) });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.match(a.body.item.id, /^tx_1794409445000_[0-9a-f]{6}$/);
  assert.notEqual(a.body.item.id, b.body.item.id);
  assert.equal(a.body.item.date, NOW.toISOString());
});

test('rejects amounts and currencies that would break the UI math', async () => {
  const db = createMemoryDb();
  const cases = [
    expense({ amount: '1250' }),
    expense({ amount: 0 }),
    expense({ amount: -5 }),
    expense({ currency: 'EUR' }),
    expense({ type: 'expense', category: '' }),
    expense({ type: 'nope' }),
    { type: 'income', amount: 10, currency: 'USD' },
  ];
  for (const body of cases) {
    const res = await call(db, 'POST', '/api/transactions', { body });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(db._all('transactions').length, 0);
});

test('transfer uses the same fields as the UI', async () => {
  const db = createMemoryDb();
  const res = await call(db, 'POST', '/api/transactions', {
    body: {
      id: 'tx_transfer_1',
      type: 'transfer',
      fromCurrency: 'USD',
      toCurrency: 'UYU',
      fromAmount: 100,
      toAmount: 4000,
      note: 'cambio',
      date: '2026-11-11T18:00:00.000Z',
    },
  });
  assert.equal(res.status, 201);
  assert.equal('category' in res.body.item, false);
  assert.deepEqual(res.body.item, {
    id: 'tx_transfer_1',
    type: 'transfer',
    fromCurrency: 'USD',
    toCurrency: 'UYU',
    fromAmount: 100,
    toAmount: 4000,
    currency: 'USD',
    amount: 100,
    note: 'cambio',
    date: '2026-11-11T18:00:00.000Z',
  });
});

test('lists transactions by date range, type, and currency', async () => {
  const db = createMemoryDb();
  await call(db, 'POST', '/api/transactions', { body: expense({ id: 'a', date: '2026-10-31', amount: 1 }) });
  await call(db, 'POST', '/api/transactions', { body: expense({ id: 'b', date: '2026-11-01', amount: 2 }) });
  await call(db, 'POST', '/api/transactions', {
    body: expense({ id: 'c', date: '2026-11-30T23:00:00.000Z', amount: 3, currency: 'USD', type: 'income', category: 'trabajo' }),
  });
  await call(db, 'POST', '/api/transactions', { body: expense({ id: 'd', date: '2026-12-01', amount: 4 }) });
  // 01:00Z del 1/11 es todavía 31/10 a la noche en Uruguay: la UI lo muestra en octubre.
  await call(db, 'POST', '/api/transactions', { body: expense({ id: 'e', date: '2026-11-01T01:00:00.000Z', amount: 5 }) });
  // 01:00Z del 1/12 es todavía 30/11 a la noche en Uruguay: la UI lo muestra en noviembre.
  await call(db, 'POST', '/api/transactions', { body: expense({ id: 'f', date: '2026-12-01T01:00:00.000Z', amount: 6 }) });

  const range = await call(db, 'GET', '/api/transactions?from=2026-11-01&to=2026-11-30');
  assert.deepEqual(range.body.items.map((item) => item.id), ['f', 'c', 'b']);
  assert.equal(range.body.truncated, false);

  const income = await call(db, 'GET', '/api/transactions?from=2026-11-01&to=2026-11-30&type=income&currency=USD');
  assert.deepEqual(income.body.items.map((item) => item.id), ['c']);

  const limited = await call(db, 'GET', '/api/transactions?limit=1');
  assert.equal(limited.body.items.length, 1);
  assert.equal(limited.body.truncated, true);
  assert.equal(limited.body.items[0].id, 'd');

  const backwards = await call(db, 'GET', '/api/transactions?from=2026-12-01&to=2026-11-01');
  assert.equal(backwards.status, 400);

  const onDebts = await call(db, 'GET', '/api/debts?from=2026-11-01');
  assert.equal(onDebts.status, 400);
});

test('updates and deletes a transaction without dropping stored fields', async () => {
  const db = createMemoryDb();
  db._put('transactions', {
    id: 'tx_manual',
    amount: 10,
    currency: 'USD',
    type: 'expense',
    category: 'ocio',
    note: 'cine',
    date: '2026-11-02T12:00:00.000Z',
    extraFromUi: 'keep',
  });

  const bad = await call(db, 'PATCH', '/api/transactions/tx_manual', { body: { nope: true } });
  assert.equal(bad.status, 400);
  assert.equal(db._all('transactions')[0].note, 'cine');

  const updated = await call(db, 'PATCH', '/api/transactions/tx_manual', { body: { note: 'cine 2' } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.item.note, 'cine 2');
  assert.equal(updated.body.item.amount, 10);
  assert.equal(updated.body.item.extraFromUi, 'keep');

  const gone = await call(db, 'DELETE', '/api/transactions/tx_manual');
  assert.deepEqual(gone.body, { deleted: true, id: 'tx_manual' });
  const missing = await call(db, 'GET', '/api/transactions/tx_manual');
  assert.equal(missing.status, 404);
  assert.equal(db._all('transactions').length, 0);
});

test('debts keep the UI document, including payments and due date', async () => {
  const db = createMemoryDb();
  const created = await call(db, 'POST', '/api/debts', {
    body: {
      id: 'debt_visa',
      entity: 'Visa',
      totalAmount: 10000,
      currency: 'UYU',
      dueDate: '2026-12-05',
      note: 'tarjeta',
    },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.item, {
    id: 'debt_visa',
    entity: 'Visa',
    totalAmount: 10000,
    currency: 'UYU',
    dueDate: '2026-12-05',
    note: 'tarjeta',
    paid: false,
    payments: [],
  });

  const paid = await call(db, 'PATCH', '/api/debts/debt_visa', {
    body: {
      payments: [{ id: 'p_1', amount: 2500, date: '2026-11-11', txId: 'tx_abono_1' }],
    },
  });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.item.entity, 'Visa');
  assert.equal(paid.body.item.paid, false);
  assert.equal(paid.body.item.payments[0].date, '2026-11-11T12:00:00.000Z');

  const archived = await call(db, 'PATCH', '/api/debts/debt_visa', { body: { paid: true } });
  assert.equal(archived.body.item.paid, true);
  assert.equal(archived.body.item.payments.length, 1);

  const list = await call(db, 'GET', '/api/debts');
  assert.equal(list.body.items[0].id, 'debt_visa');
});

test('subscriptions, events, and categories match the UI', async () => {
  const db = createMemoryDb();

  const sub = await call(db, 'POST', '/api/subscriptions', {
    body: { id: 'sub_netflix', name: 'Netflix', amount: 15, currency: 'USD', billingDay: 4 },
  });
  assert.equal(sub.status, 201);
  assert.deepEqual(Object.keys(sub.body.item), ['id', 'name', 'icon', 'amount', 'currency', 'billingDay', 'active', 'createdAt']);
  assert.equal(sub.body.item.icon, '📱');
  assert.equal(sub.body.item.active, true);
  assert.equal(sub.body.item.createdAt, NOW.toISOString());

  const paused = await call(db, 'PATCH', '/api/subscriptions/sub_netflix', { body: { active: false } });
  assert.equal(paused.body.item.active, false);
  assert.equal(paused.body.item.createdAt, NOW.toISOString());

  const event = await call(db, 'POST', '/api/events', {
    body: { id: 'evt_sueldo', name: 'Sueldo', type: 'income', day: 1, amount: 50000 },
  });
  assert.equal(event.status, 201);
  assert.deepEqual(event.body.item, {
    id: 'evt_sueldo',
    name: 'Sueldo',
    type: 'income',
    day: 1,
    amount: 50000,
    icon: '💰',
  });

  const builtin = await call(db, 'POST', '/api/categories', { body: { name: 'Comida', icon: '🍔' } });
  assert.equal(builtin.status, 400);

  const cat = await call(db, 'POST', '/api/categories', { body: { id: 'c_mascotas', name: 'Mascotas', icon: '🐾' } });
  assert.equal(cat.status, 201);
  assert.deepEqual(cat.body.item, { id: 'c_mascotas', name: 'mascotas', icon: '🐾' });

  const dup = await call(db, 'POST', '/api/categories', { body: { name: 'mascotas', icon: '🐶' } });
  assert.equal(dup.status, 409);

  const cats = await call(db, 'GET', '/api/categories');
  assert.equal(cats.body.items.length, 1);
  assert.equal(cats.body.defaults.length, DEFAULT_CATEGORIES.length);

  const removed = await call(db, 'DELETE', '/api/categories/c_mascotas');
  assert.equal(removed.body.deleted, true);
  const hiddenBuiltin = await call(db, 'DELETE', '/api/categories/comida');
  assert.equal(hiddenBuiltin.status, 404);
});

test('method and JSON errors', async () => {
  const db = createMemoryDb();
  const method = await call(db, 'PUT', '/api/transactions');
  assert.equal(method.status, 405);
  assert.equal(method.headers.Allow, 'GET, POST');
  const badJson = await call(db, 'POST', '/api/transactions', { body: '{nope' });
  assert.equal(badJson.status, 400);
  const empty = await call(db, 'PATCH', '/api/transactions/missing', { body: {} });
  assert.equal(empty.status, 400);
  const missing = await call(db, 'PATCH', '/api/transactions/missing', { body: { note: 'x' } });
  assert.equal(missing.status, 404);
});

test('vercel handler writes JSON status and does not cache', async () => {
  const db = createMemoryDb();
  const handler = createApiHandler({ getDb: async () => db, token: TOKEN, now: () => NOW });
  const res = mockRes();
  await handler({
    method: 'POST',
    url: '/api/transactions',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: expense({ id: 'gmail_1' }),
  }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.body.item.id, 'gmail_1');

  const broken = createApiHandler({
    getDb: async () => { throw Object.assign(new Error('Missing FIREBASE_PROJECT_ID'), { code: 'CONFIG' }); },
  });
  const res2 = mockRes();
  await broken({ method: 'GET', url: '/api/transactions', headers: {} }, res2);
  assert.equal(res2.statusCode, 500);
  assert.equal(res2.body.error, 'Missing FIREBASE_PROJECT_ID');
});

test('route module loads the vercel handler', async () => {
  const mod = await import('../api/[...slug].js');
  assert.equal(typeof mod.default, 'function');
});

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}
