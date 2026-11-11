// Built into the UI (index.html, DEFAULT_CATS). They are not Firestore documents.
// Keep this list in sync with that array. test/api.test.js checks it.
export const DEFAULT_CATEGORIES = [
  { id: 'comida', name: 'comida', icon: '🍔', isDefault: true },
  { id: 'transporte', name: 'transporte', icon: '🚗', isDefault: true },
  { id: 'salud', name: 'salud', icon: '🏥', isDefault: true },
  { id: 'casa', name: 'casa', icon: '🏠', isDefault: true },
  { id: 'ocio', name: 'ocio', icon: '🎮', isDefault: true },
  { id: 'trabajo', name: 'trabajo', icon: '💼', isDefault: true },
  { id: 'otro', name: 'otro', icon: '📦', isDefault: true },
  { id: 'deuda', name: 'deuda', icon: '💸', isDefault: true },
];

export const DEFAULT_CATEGORY_IDS = new Set(DEFAULT_CATEGORIES.map((c) => c.id));

export const COLLECTIONS = ['transactions', 'debts', 'subscriptions', 'events', 'categories'];

export const ID_PREFIX = {
  transactions: 'tx_',
  debts: 'debt_',
  subscriptions: 'sub_',
  events: 'evt_',
  categories: 'c_',
};

export const CURRENCIES = new Set(['USD', 'UYU']);
export const TX_TYPES = new Set(['expense', 'income', 'transfer']);
export const EVENT_TYPES = new Set(['income', 'expense']);

// Firestore document ids: no slashes, no "." / "..", no reserved __name__ pattern.
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id) && !id.includes('__');
}
