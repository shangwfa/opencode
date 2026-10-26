export * as SandboxProxyRewrite from "./rewrite.js"

/**
 * Pure response-rewriting primitives for the session preview proxy.
 *
 * A dev server running inside the sandbox emits absolute paths ("/src/main.tsx")
 * that would escape the SaaS-owned `/api/session/:id/proxy/:port` prefix, so
 * HTML/JS/CSS bodies are rewritten before they reach the browser:
 *
 * - HTML gets an inject script patching fetch/WebSocket/XHR/history at runtime
 *   plus static src/href and inline-import rewrites.
 * - JS gets import/from, dynamic import, `export default` asset strings and
 *   hard-redirect literals rewritten; `@vite/client` additionally has its HMR
 *   placeholders resolved to the proxy prefix.
 * - CSS gets `url(/…)` references rewritten.
 *
 * Every pattern guards against double-prefixing (`(?!<prefix>)`) so responses
 * from a dev server already configured with a matching base pass through.
 */

const INJECT_SCRIPT = (prefix: string) => `<script>;(function(){
var P="${prefix}";
window.__OC_PROXY_PREFIX__=P;
try{var _yd=window.YD||{};Object.defineProperty(window,"YD",{configurable:true,get:function(){return _yd},set:function(v){_yd=Object.assign({},_yd,v)}});if(_yd.__PROJECT_APP_BASE_ROUTE__===undefined)_yd.__PROJECT_APP_BASE_ROUTE__=P}catch(e){}
function f(u){return typeof u==="string"&&u.charAt(0)==="/"&&u.charAt(1)!=="/"&&!u.startsWith(P)?P+u:u}
 function fUrl(u){if(typeof u!=="string")return u;if(u.charAt(0)==="/"&&u.charAt(1)!=="/")return P+u;try{var x=new URL(u);if((x.protocol==="ws:"||x.protocol==="wss:")&&x.pathname.charAt(0)==="/"&&!x.pathname.startsWith(P)){var p=location.protocol==="https:"?"wss:":"ws:";return p+"//"+location.host+P+x.pathname+x.search+x.hash}if(x.host===location.host&&x.pathname.charAt(0)==="/"&&!x.pathname.startsWith(P))return x.origin+P+x.pathname+x.search+x.hash}catch(e){}return u}
var _ws=window.WebSocket;
window.WebSocket=function(u,pr){if(typeof u==="string")u=fUrl(u);return pr?new _ws(u,pr):new _ws(u)};
window.WebSocket.prototype=_ws.prototype;
window.WebSocket.CONNECTING=_ws.CONNECTING;window.WebSocket.OPEN=_ws.OPEN;window.WebSocket.CLOSING=_ws.CLOSING;window.WebSocket.CLOSED=_ws.CLOSED;
var _fetch=window.fetch;
window.fetch=function(i,o){
if(typeof i==="string"){i=f(i)}
else if(i instanceof Request){var x=new URL(i.url);if(x.host===location.host&&x.pathname.charAt(0)==="/"&&!x.pathname.startsWith(P))i=new Request(P+x.pathname+x.search+x.hash,i)}
return _fetch.call(window,i,o)};
var _es=window.EventSource;
window.EventSource=function(u,o){return new _es(typeof u==="string"?f(u):u,o)};
window.EventSource.prototype=_es.prototype;
window.EventSource.CONNECTING=_es.CONNECTING;window.EventSource.OPEN=_es.OPEN;window.EventSource.CLOSED=_es.CLOSED;
var _xo=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){if(typeof u==="string")arguments[1]=f(u);return _xo.apply(this,arguments)};
var _ps=history.pushState,_rs=history.replaceState;
history.pushState=function(s,t,u){if(arguments.length>2&&typeof u==="string")arguments[2]=f(u);return _ps.apply(history,arguments)};
history.replaceState=function(s,t,u){if(arguments.length>2&&typeof u==="string")arguments[2]=f(u);return _rs.apply(history,arguments)};
var _open=window.open;
window.open=function(u){if(typeof u==="string")arguments[0]=f(u);return _open.apply(window,arguments)};
function _patchSetter(proto,prop){var d=Object.getOwnPropertyDescriptor(proto,prop);if(!d||!d.set)return;Object.defineProperty(proto,prop,{set:function(u){return d.set.call(this,typeof u==="string"?f(u):u)},get:d.get,configurable:true})}
_patchSetter(HTMLScriptElement.prototype,"src");
_patchSetter(HTMLLinkElement.prototype,"href");
_patchSetter(HTMLImageElement.prototype,"src");
_patchSetter(HTMLMediaElement.prototype,"src");
})();</script>`

/** Server-start timestamp keeps `@vite/client` references out of disk cache. */
const VITE_CLIENT_BUST = `oc=${Date.now().toString(36)}`

/** prefix characters are regex-special; escape before embedding in patterns. */
function escapePrefix(prefix: string) {
  return prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function rewriteHtml(prefix: string, text: string) {
  // The escaped prefix keeps a leading unescaped "/" so lookaheads can anchor
  // on the remainder and reject an already-prefixed path.
  const escapedPrefix = escapePrefix(prefix)
  const htmlSrcHref = new RegExp(`((?:src|href)\\s*=\\s*["'])/(?!/)(?!${escapedPrefix.slice(1)})`, "g")
  let rewritten = text.replace(htmlSrcHref, `$1${prefix}/`)
  rewritten = rewritten.replace(`${prefix}/@vite/client`, `${prefix}/@vite/client?${VITE_CLIENT_BUST}`)
  rewritten = rewritten.replace(
    /(<script[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (_, open: string, code: string, close: string) => {
      if (/\ssrc\s*=/i.test(open)) return open + code + close
      let r = code.replace(new RegExp(`(import\\s*(["']))/(?!/)(?!${escapedPrefix.slice(1)})`, "g"), `$1${prefix}/`)
      // from statements anchor on statement heads (with comments — esbuild can
      // keep a JSDoc block glued to the import on one line) so plain English
      // "from" inside string literals is never rewritten.
      r = r.replace(
        new RegExp(
          `((?:^|[;{}\\n])(?:\\s|/\\*(?:[^*]|\\*(?!/))*\\*/|\\*+/?)*(?:import|export)[^;"'()]*?\\s*from\\s*(["']))/(?!/)(?!${escapedPrefix.slice(1)})`,
          "gm",
        ),
        `$1${prefix}/`,
      )
      // Inline scripts only get the same precise anchored rewrites as
      // rewriteJs; broad "quote + slash" matching corrupts regex literals in
      // minified bundles. Runtime strings stay covered by the inject script.
      r = r.replace(new RegExp(`(import\\s*\\(\\s*(?:/\\*[\\s\\S]*?\\*/\\s*)*(["']))/(?!/)(?!${escapedPrefix.slice(1)})`, "g"), `$1${prefix}/`)
      // export default only rewrites paths with a resource extension so API
      // path constants (export default "/api/users") stay intact.
      r = r.replace(
        new RegExp(`(export\\s+default\\s*(["']))/(?!/)(?!${escapedPrefix.slice(1)})(?=[^"']*\\.[A-Za-z0-9]+(?=\\?|["']))`, "g"),
        `$1${prefix}/`,
      )
      // Hard redirects cannot be patched at runtime (location is unforgeable).
      r = r.replace(new RegExp(`(location\\.(?:href|pathname)\\s*=\\s*(["']))/(?!/)(?!${escapedPrefix.slice(1)})`, "g"), `$1${prefix}/`)
      r = r.replace(new RegExp(`((?:window\\.)?location\\s*=\\s*(["']))/(?!/)(?!${escapedPrefix.slice(1)})`, "g"), `$1${prefix}/`)
      r = r.replace(new RegExp(`(location\\.(?:assign|replace)\\s*\\(\\s*(["']))/(?!/)(?!${escapedPrefix.slice(1)})`, "g"), `$1${prefix}/`)
      r = r.replace(new RegExp(`(window\\.open\\s*\\(\\s*(["']))/(?!/)(?!${escapedPrefix.slice(1)})`, "g"), `$1${prefix}/`)
      return open + r + close
    },
  )
  const inject = `<script data-oc-prefix="${prefix}"></script>${INJECT_SCRIPT(prefix)}`
  if (/<head[\s>]/i.test(rewritten)) rewritten = rewritten.replace(/(<head[^>]*>)/i, `$1${inject}`)
  else if (/<body[\s>]/i.test(rewritten)) rewritten = rewritten.replace(/(<body[^>]*>)/i, `${inject}$1`)
  else rewritten = inject + rewritten
  return rewritten
}

export function rewriteJs(prefix: string, text: string, isViteClient = false) {
  const escapedPrefix = escapePrefix(prefix)
  let rewritten = text.replace(new RegExp(`(import\\s*(["']))/(?!/)(?!${escapedPrefix.slice(1)})`, "g"), `$1${prefix}/`)
  rewritten = rewritten.replace(
    new RegExp(
      `((?:^|[;{}\\n])(?:\\s|/\\*(?:[^*]|\\*(?!/))*\\*/|\\*+/?)*(?:import|export)[^;"'()]*?\\s*from\\s*(["']))/(?!/)(?!${escapedPrefix.slice(1)})`,
      "gm",
    ),
    `$1${prefix}/`,
  )
  // Dynamic import("/x"): the paren form escapes the static-import pattern,
  // and /* @vite-ignore */ comments may sit between paren and quote.
  rewritten = rewritten.replace(new RegExp(`(import\\s*\\(\\s*(?:/\\*[\\s\\S]*?\\*/\\s*)*(["']))/(?!/)(?!${escapedPrefix.slice(1)})`, "g"), `$1${prefix}/`)
  // Vite asset imports compile to `export default "/src/assets/x.png"`; those
  // strings never flow through the fetch patch so they must be rewritten here.
  rewritten = rewritten.replace(
    new RegExp(`(export\\s+default\\s*(["']))/(?!/)(?!${escapedPrefix.slice(1)})(?=[^"']*\\.[A-Za-z0-9]+(?=\\?|["']))`, "g"),
    `$1${prefix}/`,
  )
  rewritten = rewritten.replace(new RegExp(`(location\\.(?:href|pathname)\\s*=\\s*(["']))/(?!/)(?!${escapedPrefix.slice(1)})`, "g"), `$1${prefix}/`)
  rewritten = rewritten.replace(new RegExp(`((?:window\\.)?location\\s*=\\s*(["']))/(?!/)(?!${escapedPrefix.slice(1)})`, "g"), `$1${prefix}/`)
  rewritten = rewritten.replace(new RegExp(`(location\\.(?:assign|replace)\\s*\\(\\s*(["']))/(?!/)(?!${escapedPrefix.slice(1)})`, "g"), `$1${prefix}/`)
  rewritten = rewritten.replace(new RegExp(`(window\\.open\\s*\\(\\s*(["']))/(?!/)(?!${escapedPrefix.slice(1)})`, "g"), `$1${prefix}/`)
  rewritten = rewritten.replace(/__webpack_require__\.p\s*=\s*"\/(?!\/)/g, `__webpack_require__.p="${prefix}/`)
  rewritten = rewritten.replace(/__HMR_BASE__/g, JSON.stringify(prefix + "/"))
  rewritten = rewritten.replace(/__BASE__/g, JSON.stringify(prefix + "/"))
  if (isViteClient) {
    rewritten = rewritten.replace('${"/"}', '${"' + prefix + '/"}')
    rewritten = rewritten.replace(/__HMR_CONFIG_NAME__/g, "undefined")
    rewritten = rewritten.replace(/__HMR_PROTOCOL__/g, "undefined")
    rewritten = rewritten.replace(/__HMR_PORT__/g, "undefined")
    rewritten = rewritten.replace(/__HMR_HOSTNAME__/g, "undefined")
    rewritten = rewritten.replace(/__HMR_DIRECT_TARGET__/g, "undefined")
    rewritten = rewritten.replace(/__HMR_TIMEOUT__/g, "30000")
    rewritten = rewritten.replace(/__HMR_ENABLE_OVERLAY__/g, "true")
    rewritten = rewritten.replace(/__SERVER_HOST__/g, '"localhost"')
    rewritten = rewritten.replace(/__WS_TOKEN__/g, '""')
  }
  // Router libraries define BrowserRouter and HashRouter in one module, so a
  // global patch would double-declare; apps instead read
  // window.__OC_PROXY_PREFIX__ as their basename. Cache-bust every
  // @vite/client reference so a stale cached client never handles HMR.
  rewritten = rewritten.replace(
    new RegExp(`(${escapedPrefix}/@vite/client)(?!\\?)`, "g"),
    `$1?${VITE_CLIENT_BUST}`,
  )
  return rewritten
}

export function rewriteCss(prefix: string, text: string) {
  // (?!/) skips protocol-relative url(//cdn…); (?!prefix) avoids double writes.
  const escapedPrefix = escapePrefix(prefix)
  return text.replace(new RegExp(`(url\\s*\\(\\s*["']?)/(?!/)(?!${escapedPrefix.slice(1)})`, "g"), `$1${prefix}/`)
}

export function parsePort(raw: string) {
  const p = parseInt(raw, 10)
  if (isNaN(p) || p < 1 || p > 65535) return undefined
  return p
}

export function extractSubPath(url: string, prefix: string) {
  if (!url) return "/"
  const parsed = new URL(url, "http://localhost")
  const path = parsed.pathname
  if (path.startsWith(prefix)) {
    const rest = path.slice(prefix.length)
    return rest.startsWith("/") ? rest : "/" + rest
  }
  return "/"
}

// ── proxy 502 port diagnostics ────────────────────────────────────────────────
// Collected inside the sandbox when the upstream process is gone: port listener
// state plus cgroup OOM evidence turn a vague "connection refused" into an
// error with a cause. Any failure degrades silently — diagnostics must never
// make the 502 path slower or worse.

export type PortDiagnostics = {
  portListening: boolean
  oomKillCount: number | null
  lastKilled: string | null
}

export const diagCommand = (port: number) => `printf 'PORT='; curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:${port}/ 2>/dev/null || printf '000'; printf '\\n'
printf 'OOM='; { awk '$1=="oom_kill"{print $2}' /sys/fs/cgroup/memory.events 2>/dev/null || awk '$1=="oom_kill"{print $2}' /sys/fs/cgroup/memory/memory.oom_control 2>/dev/null; } | head -1; printf '\\n'
printf 'KILLED='; dmesg 2>/dev/null | grep -i 'killed process' | tail -1 | cut -c1-200`

export function parseDiag(out: string): PortDiagnostics {
  const line = (key: string) => out.split("\n").find((l) => l.startsWith(key + "="))?.slice(key.length + 1) ?? ""
  const port = line("PORT").trim()
  const oom = line("OOM").trim()
  return {
    portListening: port !== "" && !port.startsWith("000"),
    oomKillCount: /^\d+$/.test(oom) ? Number(oom) : null,
    lastKilled: line("KILLED").trim() || null,
  }
}

export function diagHint(d: PortDiagnostics, port: number): string {
  if ((d.oomKillCount != null && d.oomKillCount > 0) || d.lastKilled)
    return `port ${port} has no listener; sandbox memory OOM detected${d.oomKillCount ? ` (cgroup oom_kill=${d.oomKillCount})` : ""}. Increase the session sandbox memory limit or restart the process.`
  return `port ${port} has no listener; no process is serving it. Start the dev server and check its output.`
}
