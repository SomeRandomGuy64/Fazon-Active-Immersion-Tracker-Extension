// Minimal assertions so the tests need no network (no jsr:/https: imports).

function eq(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => eq(a[k], b[k]));
}

export function assertEquals(actual, expected, msg = '') {
  if (!eq(actual, expected)) {
    throw new Error(`${msg ? msg + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assert(cond, msg = 'assertion failed') {
  if (!cond) throw new Error(msg);
}

export function assertThrows(fn, re) {
  try {
    fn();
  } catch (e) {
    if (re && !re.test(String(e?.message))) throw new Error(`threw ${e?.message}, expected ${re}`);
    return;
  }
  throw new Error('expected an exception');
}
