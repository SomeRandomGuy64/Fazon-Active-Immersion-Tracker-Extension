// Firefox built-in data-collection consent (Firefox 140+ desktop, 142+ Android).
//
// The Firefox manifest declares `data_collection_permissions: {required: ["none"], optional:
// SYNC_DATA_COLLECTION}`: nothing leaves the browser unless the user turns on fazon.nexus sync,
// which sends their tracked hours ("YouTube - Monday": 1.25 h — Mozilla's "browsing activity")
// authenticated with their API key ("authentication information") to api.fazon.nexus.
//
// Firefox reports granted categories as `data_collection` in permissions.getAll(); Chrome and
// older Firefox have no such key (and reject it in permissions.request), so there the explicit
// opt-in (paste a key, tick "Sync") is the consent and nothing extra is requested.

/** Optional data-collection categories that sync (and the Track total / key test) need. */
export const SYNC_DATA_COLLECTION = ['browsingActivity', 'authenticationInfo'];

/** Granted data-collection categories, or null when the browser has no built-in consent. */
export async function grantedDataCollection() {
  try {
    const all = await chrome.permissions.getAll();
    return all && Array.isArray(all.data_collection) ? all.data_collection : null;
  } catch {
    return null;
  }
}

/** True when the API may be called as far as data consent goes (always true outside Firefox 140+). */
export async function hasSyncDataConsent() {
  const granted = await grantedDataCollection();
  return granted === null || SYNC_DATA_COLLECTION.every((d) => granted.includes(d));
}
