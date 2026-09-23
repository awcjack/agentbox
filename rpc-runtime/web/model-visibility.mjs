export const STORAGE_KEY = "agentbox.pi.hidden-models.v1";
export const modelKey = (model) => JSON.stringify([model.provider, model.id]);

export function readHiddenModels(storage) {
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY));
    return new Set(Array.isArray(value) ? value.filter((key) => {
      if (typeof key !== "string") return false;
      try {
        const pair = JSON.parse(key);
        return Array.isArray(pair) && pair.length === 2 && pair.every((part) => typeof part === "string");
      } catch { return false; }
    }) : []);
  } catch { return new Set(); }
}

export function saveHiddenModels(storage, hidden) {
  try { storage.setItem(STORAGE_KEY, JSON.stringify([...hidden])); return true; }
  catch { return false; }
}

export function visibleModels(models, hidden, current) {
  return models.filter((model) => !hidden.has(modelKey(model)) || (current && modelKey(model) === modelKey(current)));
}
