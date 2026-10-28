import { describe, expect, it, vi } from "bun:test";
import {
  normalizeDocumentResources,
  type ResourceImportRequest,
} from "./resource-normalizer";

function documentWith(type: string, attrs: Record<string, unknown>) {
  return { type: "doc" as const, content: [{ type, attrs }] };
}

describe("normalizeDocumentResources", () => {
  it("converts a matching OSS URL to a relative path", async () => {
    const importResource = vi.fn();
    const result = await normalizeDocumentResources(
      documentWith("image", {
        src: "https://cdn.example.com/yddoc/assets/demo.png?sign=secret#preview",
      }),
      {
        getOssDomain: async () => "https://cdn.example.com/yddoc",
        importResource,
      },
    );

    expect(result.content.content[0]).toMatchObject({
      attrs: { src: "/yddoc/assets/demo.png" },
    });
    expect(importResource).not.toHaveBeenCalled();
  });

  it("reuploads a URL whose prefix does not match the OSS domain", async () => {
    const importResource = vi.fn(
      async (_request: ResourceImportRequest) => "/yddoc/assets/imported.png",
    );
    const result = await normalizeDocumentResources(
      documentWith("image", { src: "https://other.example.com/demo.png" }),
      {
        getOssDomain: async () => "https://cdn.example.com/yddoc",
        importResource,
      },
    );

    expect(importResource).toHaveBeenCalledWith({
      sourceType: "url",
      url: "https://other.example.com/demo.png",
      resourceKind: "image",
    });
    expect(result.content.content[0]).toMatchObject({
      attrs: { src: "/yddoc/assets/imported.png" },
    });
  });

  it("reuploads a URL on the same host but outside the OSS path prefix", async () => {
    const importResource = vi.fn(
      async (_request: ResourceImportRequest) => "/yddoc/assets/imported.png",
    );
    await normalizeDocumentResources(
      documentWith("image", {
        src: "https://cdn.example.com/other/demo.png",
      }),
      {
        getOssDomain: async () => "https://cdn.example.com/yddoc",
        importResource,
      },
    );

    expect(importResource).toHaveBeenCalledTimes(1);
  });

  it("reuploads an external rpaFlow data-blocks JSON as an attachment", async () => {
    const importResource = vi.fn(
      async (_request: ResourceImportRequest) =>
        "/yddoc/assets/imported-flow.json",
    );
    const result = await normalizeDocumentResources(
      documentWith("rpaFlow", {
        "data-blocks": "https://other.example.com/rpa-flow.json",
      }),
      {
        getOssDomain: async () => "https://cdn.example.com/yddoc",
        importResource,
      },
    );

    expect(importResource).toHaveBeenCalledWith({
      sourceType: "url",
      url: "https://other.example.com/rpa-flow.json",
      resourceKind: "attachment",
    });
    expect(result.content.content[0]).toMatchObject({
      attrs: { "data-blocks": "/yddoc/assets/imported-flow.json" },
    });
  });

  it("decodes and reuploads a data URL", async () => {
    const importResource = vi.fn(
      async (_request: ResourceImportRequest) => "/yddoc/assets/data.png",
    );
    const result = await normalizeDocumentResources(
      documentWith("image", {
        src: "data:image/png;base64,iVBORw0KGgo",
      }),
      {
        getOssDomain: async () => "https://cdn.example.com/yddoc",
        importResource,
      },
    );

    expect(importResource).toHaveBeenCalledTimes(1);
    expect(importResource.mock.calls[0]?.[0]).toMatchObject({
      sourceType: "data",
      contentType: "image/png",
      resourceKind: "image",
    });
    expect(result.content.content[0]).toMatchObject({
      attrs: { src: "/yddoc/assets/data.png" },
    });
  });

  it("returns a specific error for blob URLs", async () => {
    await expect(
      normalizeDocumentResources(
        documentWith("image", { src: "blob:https://example.com/id" }),
        {
          getOssDomain: async () => "https://cdn.example.com/yddoc",
          importResource: async () => "/unused",
        },
      ),
    ).rejects.toThrow("blob: 资源仅在创建它的浏览器上下文中有效");
  });

  it("returns a specific error for file URLs", async () => {
    await expect(
      normalizeDocumentResources(
        documentWith("video", { src: "file:///tmp/demo.mp4" }),
        {
          getOssDomain: async () => "https://cdn.example.com/yddoc",
          importResource: async () => "/unused",
        },
      ),
    ).rejects.toThrow("file: 资源指向调用方本地文件");
  });

  it("rejects credentials embedded in external URLs", async () => {
    await expect(
      normalizeDocumentResources(
        documentWith("image", {
          src: "https://user:password@other.example.com/demo.png",
        }),
        {
          getOssDomain: async () => "https://cdn.example.com/yddoc",
          importResource: async () => "/unused",
        },
      ),
    ).rejects.toThrow("外部资源 URL 不允许包含用户名或密码");
  });
});
