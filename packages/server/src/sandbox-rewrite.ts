export * as SandboxRewrite from "./sandbox-rewrite.js"

/**
 * Browser-side proxy rewriting engine (v1 sandbox-proxy parity): injects a
 * runtime patch script into HTML and statically rewrites root-absolute paths
 * in HTML/JS/CSS so the sandbox service is fully addressable under the proxy
 * prefix. Each function is a pure string transform.
 */

const INJECT_SCRIPT = (prefix: string) => `<script>;(function(){
var P="${prefix}";
window.__OC_PROXY_PREFIX__=P;
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

const VITE_CLIENT_BUST = `oc=${Date.now().toString(36)}`

const escaped = (prefix: string) => prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export function rewriteHtml(prefix: string, text: string) {
  const e = escaped(prefix)
  const htmlSrcHref = new RegExp(`((?:src|href)\\s*=\\s*["'])/(?!/)(?!${e.slice(1)})`, "g")
  let rewritten = text.replace(htmlSrcHref, `$1${prefix}/`)
  rewritten = rewritten.replace(`${prefix}/@vite/client`, `${prefix}/@vite/client?${VITE_CLIENT_BUST}`)
  rewritten = rewritten.replace(
    /(<script[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (_, open: string, code: string, close: string) => {
      if (/\ssrc\s*=/i.test(open)) return open + code + close
      let r = code.replace(new RegExp(`(import\\s*(["']))/(?!/)(?!${e.slice(1)})`, "g"), `$1${prefix}/`)
      r = r.replace(
        new RegExp(
          `((?:^|[;{}\\n])(?:\\s|/\\*(?:[^*]|\\*(?!/))*\\*/|\\*+/?)*(?:import|export)[^;"'()]*?\\s*from\\s*(["']))/(?!/)(?!${e.slice(1)})`,
          "gm",
        ),
        `$1${prefix}/`,
      )
      r = r.replace(new RegExp(`(import\\s*\\(\\s*(?:/\\*[\\s\\S]*?\\*/\\s*)*(["']))/(?!/)(?!${e.slice(1)})`, "g"), `$1${prefix}/`)
      r = r.replace(
        new RegExp(`(export\\s+default\\s*(["']))/(?!/)(?!${e.slice(1)})(?=[^"']*\\.[A-Za-z0-9]+(?=\\?|["']))`, "g"),
        `$1${prefix}/`,
      )
      r = r.replace(new RegExp(`(location\\.(?:href|pathname)\\s*=\\s*(["']))/(?!/)(?!${e.slice(1)})`, "g"), `$1${prefix}/`)
      r = r.replace(new RegExp(`((?:window\\.)?location\\s*=\\s*(["']))/(?!/)(?!${e.slice(1)})`, "g"), `$1${prefix}/`)
      r = r.replace(new RegExp(`(location\\.(?:assign|replace)\\s*\\(\\s*(["']))/(?!/)(?!${e.slice(1)})`, "g"), `$1${prefix}/`)
      r = r.replace(new RegExp(`(window\\.open\\s*\\(\\s*(["']))/(?!/)(?!${e.slice(1)})`, "g"), `$1${prefix}/`)
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
  const e = escaped(prefix)
  let rewritten = text.replace(new RegExp(`(import\\s*(["']))/(?!/)(?!${e.slice(1)})`, "g"), `$1${prefix}/`)
  rewritten = rewritten.replace(
    new RegExp(
      `((?:^|[;{}\\n])(?:\\s|/\\*(?:[^*]|\\*(?!/))*\\*/|\\*+/?)*(?:import|export)[^;"'()]*?\\s*from\\s*(["']))/(?!/)(?!${e.slice(1)})`,
      "gm",
    ),
    `$1${prefix}/`,
  )
  rewritten = rewritten.replace(new RegExp(`(import\\s*\\(\\s*(?:/\\*[\\s\\S]*?\\*/\\s*)*(["']))/(?!/)(?!${e.slice(1)})`, "g"), `$1${prefix}/`)
  rewritten = rewritten.replace(
    new RegExp(`(export\\s+default\\s*(["']))/(?!/)(?!${e.slice(1)})(?=[^"']*\\.[A-Za-z0-9]+(?=\\?|["']))`, "g"),
    `$1${prefix}/`,
  )
  rewritten = rewritten.replace(new RegExp(`(location\\.(?:href|pathname)\\s*=\\s*(["']))/(?!/)(?!${e.slice(1)})`, "g"), `$1${prefix}/`)
  rewritten = rewritten.replace(new RegExp(`((?:window\\.)?location\\s*=\\s*(["']))/(?!/)(?!${e.slice(1)})`, "g"), `$1${prefix}/`)
  rewritten = rewritten.replace(new RegExp(`(location\\.(?:assign|replace)\\s*\\(\\s*(["']))/(?!/)(?!${e.slice(1)})`, "g"), `$1${prefix}/`)
  rewritten = rewritten.replace(new RegExp(`(window\\.open\\s*\\(\\s*(["']))/(?!/)(?!${e.slice(1)})`, "g"), `$1${prefix}/`)
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
  rewritten = rewritten.replace(
    new RegExp(`(${escaped(prefix)}/@vite/client)(?!\\?)`, "g"),
    `$1?${VITE_CLIENT_BUST}`,
  )
  return rewritten
}

export function rewriteCss(prefix: string, text: string) {
  const e = escaped(prefix)
  return text.replace(new RegExp(`(url\\s*\\(\\s*["']?)/(?!/)(?!${e.slice(1)})`, "g"), `$1${prefix}/`)
}

/** Detects the content type that requires rewriting from a response's headers + path. */
export function rewriteKind(contentType: string, pathname: string): "html" | "js" | "css" | "binary" {
  if (contentType.includes("text/html")) return "html"
  if (/(?:javascript|ecmascript|text\/jsx|text\/tsx)/.test(contentType) || /\.(?:m?js|mjsx|ts|tsx)(?:\?|$)/.test(pathname))
    return "js"
  if (contentType.includes("text/css") || /\.css(?:\?|$)/.test(pathname)) return "css"
  return "binary"
}
