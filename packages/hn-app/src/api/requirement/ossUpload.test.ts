import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ossUploadUrl, uploadOssFile } from "./ossUpload";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function response(input: { ok?: boolean; body?: unknown }): Response {
  return {
    ok: input.ok ?? true,
    json: async () => input.body ?? {},
  } as Response;
}

describe("uploadOssFile", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts multipart form data to staging logs OSS upload endpoint", async () => {
    mockFetch.mockResolvedValueOnce(
      response({
        body: {
          data: {
            linkUrl: "https://cdn.example.com/recording.json.gz",
            bucket: "logs",
            etag: '"abc"',
          },
        },
      }),
    );

    const file = new Blob(["{}"], { type: "application/json" });
    const result = await uploadOssFile({
      key: "requirement-recordings/req/session/part.json",
      file,
      name: "part.json",
      type: "application/json",
      bucket: "logs",
      acl: "PUBLIC_READ",
      canOverride: true,
    });

    expect(result).toEqual({
      linkUrl: "https://cdn.example.com/recording.json.gz",
      bucket: "logs",
      etag: '"abc"',
      expireDate: undefined,
    });
    expect(mockFetch).toHaveBeenCalledWith(
      ossUploadUrl,
      expect.objectContaining({ method: "POST" }),
    );

    const init = mockFetch.mock.calls[0][1] as RequestInit;
    const form = init.body as FormData;
    expect(form.get("key")).toBe("requirement-recordings/req/session/part.json");
    expect(form.get("name")).toBe("part.json");
    expect(form.get("type")).toBe("application/json");
    expect(form.get("bucket")).toBe("logs");
    expect(form.get("acl")).toBe("PUBLIC_READ");
    expect(form.get("canOverride")).toBe("true");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("throws when response is not ok", async () => {
    mockFetch.mockResolvedValueOnce(
      response({ ok: false, body: { message: "upload denied" } }),
    );

    await expect(
      uploadOssFile({
        key: "a/b.json",
        file: new Blob(["{}"]),
      }),
    ).rejects.toThrow("upload denied");
  });

  it("throws when linkUrl is missing", async () => {
    mockFetch.mockResolvedValueOnce(response({ body: { data: {} } }));

    await expect(
      uploadOssFile({
        key: "a/b.json",
        file: new Blob(["{}"]),
      }),
    ).rejects.toThrow("OSS 上传成功但未返回 linkUrl");
  });
});
