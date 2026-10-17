// Stand-in for Node builtins (http, net, crypto, ...) pulled in by the MCP server code. Importing is harmless; using throws.
const fail = (name) => function () { throw new Error("Node API '" + name + "' is not available in the web preview"); };
const handler = {
  get(_t, key) {
    if (key === "__esModule") return false;
    if (key === "default") return proxy;
    if (key === "randomBytes") return (n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); b.toString = (enc) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); return b; };
    if (key === "timingSafeEqual") return (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    if (key === "then") return undefined;
    return makeStub(String(key));
  },
};
function makeStub(name) { const f = fail(name); return new Proxy(f, { get: (t, k) => (k === "prototype" ? t.prototype : k === "then" ? undefined : makeStub(name + "." + String(k))) }); }
const proxy = new Proxy({}, handler);
module.exports = proxy;
