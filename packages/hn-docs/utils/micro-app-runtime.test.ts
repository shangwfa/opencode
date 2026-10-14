import { afterEach, describe, expect, it, vi } from "vitest";

import { protectHostHeadOperations } from "./micro-app-runtime";

class FakeElement {
  children: FakeElement[] = [];
  tagName = "DIV";
  private readonly attributes = new Map<string, string>();

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  append(...elements: FakeElement[]) {
    this.children.push(...elements);
  }

  appendChild(element: FakeElement) {
    this.children.push(element);
    return element;
  }

  insertBefore(element: FakeElement, reference: FakeElement | null) {
    const index = reference ? this.children.indexOf(reference) : -1;
    this.children.splice(index >= 0 ? index : this.children.length, 0, element);
    return element;
  }

  prepend(...elements: FakeElement[]) {
    this.children.unshift(...elements);
  }

  querySelector(selectors: string): FakeElement | null {
    return (
      this.children.find(
        (element) =>
          selectors === "meta[name=next-head-count]" &&
          element.tagName === "META" &&
          element.getAttribute("name") === "next-head-count",
      ) ?? null
    );
  }

  querySelectorAll() {
    return this.children;
  }

  removeChild(element: FakeElement) {
    this.children = this.children.filter((child) => child !== element);
    return element;
  }

  replaceChild(element: FakeElement, replaced: FakeElement) {
    const index = this.children.indexOf(replaced);
    if (index >= 0) this.children[index] = element;
    return replaced;
  }
}

describe("protectHostHeadOperations", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps Next's head marker visible after the global selector is patched", () => {
    const head = new FakeElement();
    head.tagName = "HEAD";

    const marker = new FakeElement();
    marker.tagName = "META";
    marker.setAttribute("name", "next-head-count");
    head.children.push(marker);

    vi.stubGlobal("Element", FakeElement);
    vi.stubGlobal("document", { head });

    protectHostHeadOperations();

    // Simulate micro-app replacing Element.prototype.querySelector and routing
    // the host head query into a child <micro-app-head> without Next's marker.
    vi.spyOn(FakeElement.prototype, "querySelector").mockReturnValue(null);

    expect(head.querySelector("meta[name=next-head-count]")).toBe(marker);
  });

  it("keeps host chunks and styles out of the child micro-app head", () => {
    const head = new FakeElement();
    head.tagName = "HEAD";
    const microAppHead = new FakeElement();

    vi.stubGlobal("Element", FakeElement);
    vi.stubGlobal("document", { head });

    protectHostHeadOperations();

    vi.spyOn(FakeElement.prototype, "appendChild").mockImplementation(
      (element) => {
        microAppHead.children.push(element);
        return element;
      },
    );
    vi.spyOn(FakeElement.prototype, "insertBefore").mockImplementation(
      (element) => {
        microAppHead.children.push(element);
        return element;
      },
    );

    const chunk = new FakeElement();
    chunk.tagName = "SCRIPT";
    const style = new FakeElement();
    style.tagName = "STYLE";

    head.appendChild(chunk);
    head.insertBefore(style, chunk);

    expect(head.children).toEqual([style, chunk]);
    expect(microAppHead.children).toEqual([]);
  });
});
