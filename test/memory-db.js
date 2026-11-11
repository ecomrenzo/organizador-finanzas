function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function matches(value, op, expected) {
  if (op === '==') return value === expected;
  if (op === '>=') return value >= expected;
  if (op === '<=') return value <= expected;
  throw new Error(`Unsupported operator ${op}`);
}

function createQuery(docs, filters = [], orders = [], limitN = null) {
  return {
    where(field, op, value) {
      return createQuery(docs, [...filters, { field, op, value }], orders, limitN);
    },
    orderBy(field, direction = 'asc') {
      return createQuery(docs, filters, [...orders, { field, direction }], limitN);
    },
    limit(n) {
      return createQuery(docs, filters, orders, n);
    },
    async get() {
      let rows = [...docs.entries()].map(([id, data]) => ({ id, data }));
      if (orders.length) {
        rows = rows.filter((row) => orders.every((order) => row.data[order.field] != null));
      }
      for (const filter of filters) {
        rows = rows.filter((row) => matches(row.data[filter.field], filter.op, filter.value));
      }
      if (orders.length) {
        rows.sort((a, b) => {
          for (const order of orders) {
            const av = a.data[order.field];
            const bv = b.data[order.field];
            if (av < bv) return order.direction === 'desc' ? 1 : -1;
            if (av > bv) return order.direction === 'desc' ? -1 : 1;
          }
          return 0;
        });
      }
      if (limitN != null) rows = rows.slice(0, limitN);
      return {
        size: rows.length,
        empty: rows.length === 0,
        docs: rows.map((row) => ({
          id: row.id,
          data: () => clone(row.data),
        })),
      };
    },
  };
}

function docRef(docs, id) {
  return {
    id,
    async get() {
      if (!docs.has(id)) return { exists: false, id, data: () => undefined };
      return { exists: true, id, data: () => clone(docs.get(id)) };
    },
    set(data) {
      docs.set(id, clone(data));
    },
    delete() {
      docs.delete(id);
    },
  };
}

function collectionRef(docs) {
  const query = () => createQuery(docs);
  return {
    doc: (id) => docRef(docs, id),
    where: (...args) => query().where(...args),
    orderBy: (...args) => query().orderBy(...args),
    limit: (n) => query().limit(n),
    get: () => query().get(),
  };
}

export function createMemoryDb() {
  const collections = new Map();

  function docsOf(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }

  return {
    collection(root) {
      if (root !== 'data') throw new Error(`Unexpected collection ${root}`);
      return {
        doc(id) {
          if (id !== 'main') throw new Error(`Unexpected document ${id}`);
          return {
            collection(name) {
              return collectionRef(docsOf(name));
            },
          };
        },
      };
    },
    async runTransaction(fn) {
      return fn({
        get: (ref) => ref.get(),
        set: (ref, data) => { ref.set(data); },
        delete: (ref) => { ref.delete(); },
      });
    },
    _put(name, data) {
      docsOf(name).set(data.id, clone(data));
    },
    _all(name) {
      return [...docsOf(name).values()].map((data) => clone(data));
    },
  };
}
