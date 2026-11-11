const MAX_SCAN = 5000;

function base(db, name) {
  return db.collection('data').doc('main').collection(name);
}

function sortItems(name, items) {
  const copy = items.slice();
  if (name === 'debts') {
    copy.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  } else if (name === 'subscriptions') {
    copy.sort((a, b) => (a.billingDay || 0) - (b.billingDay || 0) || String(a.name).localeCompare(String(b.name), 'es'));
  } else if (name === 'events') {
    copy.sort((a, b) => (a.day || 0) - (b.day || 0) || String(a.name).localeCompare(String(b.name), 'es'));
  } else if (name === 'categories') {
    copy.sort((a, b) => String(a.name).localeCompare(String(b.name), 'es'));
  }
  return copy;
}

export async function listDocuments(db, name, query) {
  const col = base(db, name);
  if (name !== 'transactions') {
    const snap = await col.get();
    return { items: sortItems(name, snap.docs.map((doc) => doc.data())), truncated: false };
  }

  let q = col;
  if (query.from) q = q.where('date', '>=', query.from);
  if (query.to) q = q.where('date', '<=', query.to);
  q = q.orderBy('date', 'desc').limit(MAX_SCAN);
  const snap = await q.get();
  let items = snap.docs.map((doc) => doc.data());
  if (query.type) items = items.filter((item) => item.type === query.type);
  if (query.currency) items = items.filter((item) => item.currency === query.currency);
  const truncated = snap.size >= MAX_SCAN || items.length > query.limit;
  if (items.length > query.limit) items = items.slice(0, query.limit);
  return { items, truncated };
}

export async function getDocument(db, name, id) {
  const snap = await base(db, name).doc(id).get();
  if (!snap.exists) return null;
  return snap.data();
}

export async function createDocument(db, name, data) {
  const ref = base(db, name).doc(data.id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return { created: false, item: snap.data() };
    tx.set(ref, data);
    return { created: true, item: data };
  });
}

export async function updateDocument(db, name, id, merge) {
  const ref = base(db, name).doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { found: false };
    const result = merge(snap.data());
    if (!result.ok) return { found: true, error: result.error };
    tx.set(ref, result.value);
    return { found: true, item: result.value };
  });
}

export async function deleteDocument(db, name, id) {
  const ref = base(db, name).doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    tx.delete(ref);
    return true;
  });
}

export async function categoryNameTaken(db, name, exceptId) {
  const snap = await base(db, 'categories').get();
  return snap.docs.some((doc) => {
    const data = doc.data();
    return data.name === name && data.id !== exceptId;
  });
}
