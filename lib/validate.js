import { randomBytes } from 'node:crypto';
import {
  CURRENCIES,
  DEFAULT_CATEGORY_IDS,
  EVENT_TYPES,
  ID_PREFIX,
  TX_TYPES,
  isValidId,
} from './defaults.js';

const TX_FIELDS = ['id', 'amount', 'currency', 'type', 'category', 'note', 'date', 'fromCurrency', 'toCurrency', 'fromAmount', 'toAmount'];
const DEBT_FIELDS = ['id', 'entity', 'totalAmount', 'currency', 'dueDate', 'note', 'paid', 'payments'];
const PAYMENT_FIELDS = ['id', 'amount', 'date', 'txId'];
const SUB_FIELDS = ['id', 'name', 'icon', 'amount', 'currency', 'billingDay', 'active', 'createdAt'];
const EVENT_FIELDS = ['id', 'name', 'type', 'day', 'amount', 'icon'];
const CATEGORY_FIELDS = ['id', 'name', 'icon'];

const WRITABLE = {
  transactions: TX_FIELDS,
  debts: DEBT_FIELDS,
  subscriptions: SUB_FIELDS.filter((k) => k !== 'createdAt'),
  events: EVENT_FIELDS,
  categories: CATEGORY_FIELDS,
};

function fail(error) {
  return { ok: false, error };
}

function unknownField(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Body must be a JSON object';
  }
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) return `Unknown field: ${key}`;
  }
  return null;
}

function cleanText(value, { max, label, allowEmpty = false }) {
  if (typeof value !== 'string') return fail(`${label} must be a string`);
  const text = value.trim();
  if (!allowEmpty && text.length === 0) return fail(`${label} is required`);
  if (text.length > max) return fail(`${label} must be at most ${max} characters`);
  if (/[\u0000-\u001F\u007F]/.test(text)) return fail(`${label} contains control characters`);
  return { ok: true, value: text };
}

function positiveNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fail(`${label} must be a number greater than 0`);
  }
  if (value > 1e12) return fail(`${label} is too large`);
  return { ok: true, value };
}

function currencyOf(value, label = 'currency') {
  if (!CURRENCIES.has(value)) return fail(`${label} must be USD or UYU`);
  return { ok: true, value };
}

// Uruguay no usa horario de verano: el mes de la UI (hora local) coincide con UTC−3.
const URUGUAY_OFFSET = '-03:00';

function uruguayDayStart(ymd) {
  return new Date(`${ymd}T00:00:00.000${URUGUAY_OFFSET}`).toISOString();
}

function uruguayDayEnd(ymd) {
  return new Date(`${ymd}T23:59:59.999${URUGUAY_OFFSET}`).toISOString();
}

function validYmd(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Date-only values are stored at noon UTC so the calendar day stays the same
// in Uruguay (UTC−3) when the UI does `new Date(date).getMonth()`.
export function normalizeTimestamp(value, { required = true, now, defaultNow = false } = {}) {
  if (value == null || value === '') {
    if (defaultNow) {
      return { ok: true, value: (now instanceof Date ? now : new Date()).toISOString() };
    }
    if (!required) return { ok: true, value: null };
    return fail('date is required');
  }
  if (typeof value !== 'string') return fail('date must be an ISO string');
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (!validYmd(value)) return fail('date is not a real calendar day');
    return { ok: true, value: `${value}T12:00:00.000Z` };
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fail('date is not a valid ISO datetime');
  return { ok: true, value: parsed.toISOString() };
}

function dueDateOf(value) {
  if (value == null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string' || !validYmd(value)) {
    return fail('dueDate must be YYYY-MM-DD or null');
  }
  return { ok: true, value };
}

function dayOfMonth(value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 31) {
    return fail(`${label} must be an integer from 1 to 31`);
  }
  return { ok: true, value };
}

function iconOf(value, { required }) {
  if (value == null || value === '') {
    if (!required) return { ok: true, value: null };
    return fail('icon is required');
  }
  if (typeof value !== 'string') return fail('icon must be a string');
  const icon = value.trim();
  if (icon.length < 1 || icon.length > 16) return fail('icon must be 1 to 16 characters');
  if (/[&<>"'`\\/]/.test(icon)) return fail('icon has characters the UI would treat as HTML');
  return { ok: true, value: icon };
}

function paymentOf(raw) {
  const unknown = unknownField(raw, PAYMENT_FIELDS);
  if (unknown) return fail(`payment: ${unknown}`);
  if (!isValidId(raw.id)) return fail('payment.id is missing or invalid');
  const amount = positiveNumber(raw.amount, 'payment.amount');
  if (!amount.ok) return amount;
  const date = normalizeTimestamp(raw.date, { required: true });
  if (!date.ok) return fail(`payment.${date.error}`);
  if (!isValidId(raw.txId)) return fail('payment.txId is missing or invalid');
  return {
    ok: true,
    value: { id: raw.id, amount: amount.value, date: date.value, txId: raw.txId },
  };
}

function normalizeTransaction(input, { now }) {
  if (!TX_TYPES.has(input.type)) return fail('type must be expense, income, or transfer');

  const note = cleanText(input.note == null ? '' : input.note, { max: 500, label: 'note', allowEmpty: true });
  if (!note.ok) return note;
  const date = normalizeTimestamp(input.date, { defaultNow: true, now });
  if (!date.ok) return date;

  if (input.type === 'transfer') {
    const fromCurrency = currencyOf(input.fromCurrency, 'fromCurrency');
    if (!fromCurrency.ok) return fromCurrency;
    const toCurrency = currencyOf(input.toCurrency, 'toCurrency');
    if (!toCurrency.ok) return toCurrency;
    if (fromCurrency.value === toCurrency.value) {
      return fail('fromCurrency and toCurrency must be different');
    }
    const fromAmount = positiveNumber(input.fromAmount, 'fromAmount');
    if (!fromAmount.ok) return fromAmount;
    const toAmount = positiveNumber(input.toAmount, 'toAmount');
    if (!toAmount.ok) return toAmount;
    if (input.currency != null && input.currency !== fromCurrency.value) {
      return fail('currency must match fromCurrency');
    }
    if (input.amount != null && input.amount !== fromAmount.value) {
      return fail('amount must match fromAmount');
    }
    if (input.category != null) return fail('Unknown field: category');
    return {
      ok: true,
      value: {
        type: 'transfer',
        fromCurrency: fromCurrency.value,
        toCurrency: toCurrency.value,
        fromAmount: fromAmount.value,
        toAmount: toAmount.value,
        currency: fromCurrency.value,
        amount: fromAmount.value,
        note: note.value,
        date: date.value,
      },
    };
  }

  const amount = positiveNumber(input.amount, 'amount');
  if (!amount.ok) return amount;
  const currency = currencyOf(input.currency);
  if (!currency.ok) return currency;
  if (typeof input.category !== 'string' || !isValidId(input.category)) {
    return fail('category must be a category id');
  }
  for (const extra of ['fromCurrency', 'toCurrency', 'fromAmount', 'toAmount']) {
    if (input[extra] != null) return fail(`Unknown field: ${extra}`);
  }
  return {
    ok: true,
    value: {
      amount: amount.value,
      currency: currency.value,
      type: input.type,
      category: input.category,
      note: note.value,
      date: date.value,
    },
  };
}

function normalizeDebt(input) {
  const entity = cleanText(input.entity, { max: 120, label: 'entity' });
  if (!entity.ok) return entity;
  const totalAmount = positiveNumber(input.totalAmount, 'totalAmount');
  if (!totalAmount.ok) return totalAmount;
  const currency = currencyOf(input.currency);
  if (!currency.ok) return currency;
  const dueDate = dueDateOf(input.dueDate);
  if (!dueDate.ok) return dueDate;
  const note = cleanText(input.note == null ? '' : input.note, { max: 500, label: 'note', allowEmpty: true });
  if (!note.ok) return note;
  if (input.paid != null && typeof input.paid !== 'boolean') return fail('paid must be true or false');
  const rawPayments = input.payments == null ? [] : input.payments;
  if (!Array.isArray(rawPayments)) return fail('payments must be an array');
  if (rawPayments.length > 500) return fail('payments is too long');
  const payments = [];
  for (const raw of rawPayments) {
    const payment = paymentOf(raw);
    if (!payment.ok) return payment;
    payments.push(payment.value);
  }
  return {
    ok: true,
    value: {
      entity: entity.value,
      totalAmount: totalAmount.value,
      currency: currency.value,
      dueDate: dueDate.value,
      note: note.value,
      paid: input.paid === true,
      payments,
    },
  };
}

function normalizeSubscription(input, { now, existing }) {
  const name = cleanText(input.name, { max: 120, label: 'name' });
  if (!name.ok) return name;
  const icon = iconOf(input.icon == null || input.icon === '' ? '📱' : input.icon, { required: true });
  if (!icon.ok) return icon;
  const amount = positiveNumber(input.amount, 'amount');
  if (!amount.ok) return amount;
  const currency = currencyOf(input.currency);
  if (!currency.ok) return currency;
  const billingDay = dayOfMonth(input.billingDay, 'billingDay');
  if (!billingDay.ok) return billingDay;
  if (input.active != null && typeof input.active !== 'boolean') return fail('active must be true or false');
  const createdAt = existing?.createdAt
    ? normalizeTimestamp(existing.createdAt, { required: true })
    : { ok: true, value: (now instanceof Date ? now : new Date()).toISOString() };
  if (!createdAt.ok) return fail('createdAt on the stored subscription is invalid');
  return {
    ok: true,
    value: {
      name: name.value,
      icon: icon.value,
      amount: amount.value,
      currency: currency.value,
      billingDay: billingDay.value,
      active: input.active == null ? true : input.active,
      createdAt: createdAt.value,
    },
  };
}

function normalizeEvent(input) {
  const name = cleanText(input.name, { max: 120, label: 'name' });
  if (!name.ok) return name;
  if (!EVENT_TYPES.has(input.type)) return fail('type must be income or expense');
  const day = dayOfMonth(input.day, 'day');
  if (!day.ok) return day;
  let amount = null;
  if (input.amount != null) {
    const parsed = positiveNumber(input.amount, 'amount');
    if (!parsed.ok) return parsed;
    amount = parsed.value;
  }
  const fallback = input.type === 'income' ? '💰' : '💸';
  const icon = iconOf(input.icon == null || input.icon === '' ? fallback : input.icon, { required: true });
  if (!icon.ok) return icon;
  return {
    ok: true,
    value: {
      name: name.value,
      type: input.type,
      day: day.value,
      amount,
      icon: icon.value,
    },
  };
}

function normalizeCategory(input) {
  const name = cleanText(input.name, { max: 40, label: 'name' });
  if (!name.ok) return name;
  const normalized = name.value.toLowerCase();
  if (!/^[a-z0-9áéíóúüñ][a-z0-9áéíóúüñ _-]{0,39}$/i.test(normalized)) {
    return fail('name has characters the UI does not expect');
  }
  const icon = iconOf(input.icon, { required: true });
  if (!icon.ok) return icon;
  if (DEFAULT_CATEGORY_IDS.has(normalized)) {
    return fail('that name is already a built-in category');
  }
  return { ok: true, value: { name: normalized, icon: icon.value } };
}

function normalize(collection, input, ctx) {
  switch (collection) {
    case 'transactions': return normalizeTransaction(input, ctx);
    case 'debts': return normalizeDebt(input);
    case 'subscriptions': return normalizeSubscription(input, ctx);
    case 'events': return normalizeEvent(input);
    case 'categories': return normalizeCategory(input);
    default: return fail('Unknown collection');
  }
}

export function newDocumentId(collection, now = new Date()) {
  const prefix = ID_PREFIX[collection];
  const suffix = randomBytes(3).toString('hex');
  return `${prefix}${now.getTime()}_${suffix}`;
}

export function normalizeCreate(collection, body, ctx) {
  const unknown = unknownField(body, WRITABLE[collection]);
  if (unknown) return fail(unknown);
  let id = body.id;
  if (id == null || id === '') {
    id = newDocumentId(collection, ctx.now);
  } else if (!isValidId(id)) {
    return fail('id must be 1–128 characters: letters, digits, _ or -');
  }
  const normalized = normalize(collection, body, ctx);
  if (!normalized.ok) return normalized;
  return { ok: true, value: { id, ...normalized.value } };
}

export function normalizeUpdate(collection, existing, patch, ctx) {
  const unknown = unknownField(patch, WRITABLE[collection]);
  if (unknown) return fail(unknown);
  if (patch.id != null && patch.id !== existing.id) return fail('id cannot be changed');
  const merged = { ...existing };
  for (const key of WRITABLE[collection]) {
    if (key === 'id') continue;
    if (Object.prototype.hasOwnProperty.call(patch, key)) merged[key] = patch[key];
  }
  const normalized = normalize(collection, merged, { ...ctx, existing });
  if (!normalized.ok) return normalized;
  const extras = {};
  const canonical = new Set(['id', ...Object.keys(normalized.value)]);
  for (const [key, value] of Object.entries(existing)) {
    if (!canonical.has(key)) extras[key] = value;
  }
  return { ok: true, value: { ...extras, id: existing.id, ...normalized.value } };
}

export function parseListQuery(collection, searchParams) {
  const fromRaw = searchParams.get('from');
  const toRaw = searchParams.get('to');
  const type = searchParams.get('type');
  const currency = searchParams.get('currency');
  const limitRaw = searchParams.get('limit');

  if (collection !== 'transactions') {
    if (fromRaw || toRaw || type || currency) {
      return fail('from, to, type, and currency filters are only for transactions');
    }
  }

  let limit = 1000;
  if (limitRaw != null && limitRaw !== '') {
    if (!/^\d+$/.test(limitRaw)) return fail('limit must be an integer');
    limit = Number(limitRaw);
    if (limit < 1 || limit > 2000) return fail('limit must be between 1 and 2000');
  }

  let from = null;
  let to = null;
  if (collection === 'transactions') {
    if (fromRaw) {
      const parsed = normalizeTimestamp(fromRaw, { required: true });
      if (!parsed.ok) return fail(`from ${parsed.error.replace(/^date /, '')}`);
      from = /^\d{4}-\d{2}-\d{2}$/.test(fromRaw) ? uruguayDayStart(fromRaw) : parsed.value;
    }
    if (toRaw) {
      const parsed = normalizeTimestamp(toRaw, { required: true });
      if (!parsed.ok) return fail(`to ${parsed.error.replace(/^date /, '')}`);
      to = /^\d{4}-\d{2}-\d{2}$/.test(toRaw) ? uruguayDayEnd(toRaw) : parsed.value;
    }
    if (from && to && from > to) return fail('from must be before to');
    if (type && !TX_TYPES.has(type)) return fail('type must be expense, income, or transfer');
    if (currency && !CURRENCIES.has(currency)) return fail('currency must be USD or UYU');
  }

  return { ok: true, value: { from, to, type: type || null, currency: currency || null, limit } };
}
