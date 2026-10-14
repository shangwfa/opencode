import type { MicroApp } from "@micro-zoe/micro-app";

const MICRO_APP_RUNTIME_KEY = Symbol.for("xybot.micro-app.runtime.v1");
const HOST_HEAD_DOM_GUARD_KEY = Symbol.for(
  "xybot.micro-app.host-head-dom-guard.v2",
);

const NEXT_HEAD_COUNT_SELECTOR = "meta[name=next-head-count]";

type GuardedHead = HTMLHeadElement & {
  [HOST_HEAD_DOM_GUARD_KEY]?: boolean;
};

interface MicroAppRuntimeState {
  instancePromise?: Promise<MicroApp>;
  owner?: string;
  tagName?: string;
}

const getRuntimeState = (): MicroAppRuntimeState => {
  const globalScope = globalThis as typeof globalThis & {
    [MICRO_APP_RUNTIME_KEY]?: MicroAppRuntimeState;
  };

  globalScope[MICRO_APP_RUNTIME_KEY] ??= {};
  return globalScope[MICRO_APP_RUNTIME_KEY];
};

/**
 * micro-app patches the global Element/Node prototypes while a child sandbox
 * is active. If its async DOM scope overlaps a host update, queries and writes
 * on document.head are redirected to <micro-app-head>. This can hide Next's
 * next-head-count marker, rewrite a host chunk URL against the child app URL,
 * or place host runtime styles inside the child app.
 *
 * Pin the host head to the DOM methods that existed before micro-app starts.
 * Child applications use their proxy/iframe head and remain sandboxed.
 */
export const protectHostHeadOperations = (): void => {
  if (typeof document === "undefined" || typeof Element === "undefined") {
    return;
  }

  const head = document.head as GuardedHead | null;
  if (!head || head[HOST_HEAD_DOM_GUARD_KEY]) return;

  const originalMethods = {
    append: head.append,
    appendChild: head.appendChild,
    insertBefore: head.insertBefore,
    prepend: head.prepend,
    querySelector: head.querySelector,
    querySelectorAll: head.querySelectorAll,
    removeChild: head.removeChild,
    replaceChild: head.replaceChild,
  };

  Object.defineProperties(head, {
    append: {
      configurable: true,
      value: originalMethods.append.bind(head),
    },
    appendChild: {
      configurable: true,
      value: originalMethods.appendChild.bind(head),
    },
    insertBefore: {
      configurable: true,
      value: originalMethods.insertBefore.bind(head),
    },
    prepend: {
      configurable: true,
      value: originalMethods.prepend.bind(head),
    },
    querySelector: {
      configurable: true,
      value: function querySelector(this: HTMLHeadElement, selectors: string) {
        if (selectors === NEXT_HEAD_COUNT_SELECTOR) {
          return (
            Array.from(this.children).find(
              (element) =>
                element.tagName === "META" &&
                element.getAttribute("name") === "next-head-count",
            ) ?? null
          );
        }

        return originalMethods.querySelector.call(this, selectors);
      },
    },
    querySelectorAll: {
      configurable: true,
      value: originalMethods.querySelectorAll.bind(head),
    },
    removeChild: {
      configurable: true,
      value: originalMethods.removeChild.bind(head),
    },
    replaceChild: {
      configurable: true,
      value: originalMethods.replaceChild.bind(head),
    },
    [HOST_HEAD_DOM_GUARD_KEY]: {
      configurable: true,
      value: true,
    },
  });
};

/**
 * Initialize the single micro-app runtime used by the book and all SDKs.
 * SDKs use the same Symbol.for key, so the first caller starts the runtime and
 * every later caller reuses the same promise and tag name.
 */
export const ensureMicroAppRuntime = (
  owner = "xybot-front-book-v3",
): Promise<MicroApp> => {
  if (typeof window === "undefined" || !window.customElements) {
    return Promise.reject(
      new Error("micro-app requires the browser Custom Elements API"),
    );
  }

  const runtime = getRuntimeState();

  if (!runtime.instancePromise) {
    protectHostHeadOperations();

    const initialization = import("@micro-zoe/micro-app").then((module) => {
      const microApp = module.default;

      if (!microApp.hasInit) {
        runtime.owner = owner;
        microApp.start({ tagName: "micro-app" });
      } else {
        runtime.owner ??= "external-host";
      }

      const tagName = microApp.tagName || "micro-app";
      runtime.tagName = tagName;

      if (!window.customElements.get(tagName)) {
        throw new Error(
          `[micro-app-runtime] Runtime initialized by ${runtime.owner}, but <${tagName}> is not registered`,
        );
      }

      return microApp;
    });

    runtime.instancePromise = initialization.catch((error) => {
      runtime.instancePromise = undefined;
      throw error;
    });
  }

  return runtime.instancePromise;
};
