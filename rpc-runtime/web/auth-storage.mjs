export const STORAGE_KEY = "agentbox.pi.auth-token.v1";

/** Raw bearer tokens: non-empty printable ASCII without whitespace. */
export function isRememberableToken(token) {
  return typeof token === "string" && token.length > 0 && !/\s/.test(token) && /^[\x21-\x7E]+$/.test(token);
}

export function readRememberedToken(storage) {
  try {
    const value = storage?.getItem?.(STORAGE_KEY);
    return isRememberableToken(value) ? value : "";
  } catch {
    return "";
  }
}

export function saveRememberedToken(storage, token) {
  if (!isRememberableToken(token)) return false;
  try {
    storage.setItem(STORAGE_KEY, token);
    return true;
  } catch {
    return false;
  }
}

export function clearRememberedToken(storage) {
  try {
    storage?.removeItem?.(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
