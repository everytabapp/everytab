/** Transactional in-memory adapter for tests at the storage module interface. */

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const encodedKey = (value) => JSON.stringify(value);

function pathValue(value, keyPath) {
  if (Array.isArray(keyPath)) return keyPath.map((key) => value[key]);
  return value[keyPath];
}

function compareKeys(left, right) {
  const a = Array.isArray(left) ? left : [left];
  const b = Array.isArray(right) ? right : [right];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === b[i]) continue;
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function createMemoryIndexedDbAdapter(schema) {
  const descriptors = new Map(schema.stores.map((store) => [store.name, store]));
  const stores = new Map(schema.stores.map((store) => [store.name, new Map()]));
  let tail = Promise.resolve();

  function run(storeNames, mode, work) {
    const execute = async () => {
      const selected = new Map();
      for (const name of new Set(storeNames)) {
        if (!descriptors.has(name)) throw new Error(`Unknown object store ${name}`);
        selected.set(name, new Map([...stores.get(name)].map(([key, value]) => [key, clone(value)])));
      }
      const mapFor = (name) => {
        if (!selected.has(name)) throw new Error(`Store ${name} is outside this transaction`);
        return selected.get(name);
      };
      const context = {
        async get(name, key) {
          return clone(mapFor(name).get(encodedKey(key)));
        },
        async getAll(name) {
          return [...mapFor(name).values()].map(clone);
        },
        async getAllByKeyRange(name, {
          lower, upper, lowerOpen = false, upperOpen = false
        }, count) {
          const descriptor = descriptors.get(name);
          return [...mapFor(name).values()]
            .sort((left, right) => compareKeys(
              pathValue(left, descriptor.keyPath), pathValue(right, descriptor.keyPath)))
            .filter((value) => {
              const key = pathValue(value, descriptor.keyPath);
              const from = compareKeys(key, lower);
              const through = compareKeys(key, upper);
              return (lowerOpen ? from > 0 : from >= 0) &&
                (upperOpen ? through < 0 : through <= 0);
            })
            .slice(0, Number.isSafeInteger(count) ? count : undefined)
            .map(clone);
        },
        async getAllByIndex(name, indexName, query) {
          const descriptor = descriptors.get(name);
          const index = descriptor.indexes?.find((candidate) => candidate.name === indexName);
          if (!index) throw new Error(`Unknown index ${name}.${indexName}`);
          return [...mapFor(name).values()]
            .filter((value) => encodedKey(pathValue(value, index.keyPath)) === encodedKey(query))
            .map(clone);
        },
        async put(name, value) {
          if (mode !== "readwrite") throw new Error("Readonly transaction cannot write");
          const descriptor = descriptors.get(name);
          const key = pathValue(value, descriptor.keyPath);
          mapFor(name).set(encodedKey(key), clone(value));
          return clone(key);
        },
        async delete(name, key) {
          if (mode !== "readwrite") throw new Error("Readonly transaction cannot delete");
          mapFor(name).delete(encodedKey(key));
        }
      };
      const result = await work(context);
      if (mode === "readwrite") {
        for (const [name, values] of selected) stores.set(name, values);
      }
      return result;
    };
    const pending = tail.then(execute, execute);
    tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  return { transaction: run, async close() {} };
}
