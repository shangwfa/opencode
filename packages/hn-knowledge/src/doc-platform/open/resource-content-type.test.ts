import { describe, expect, it } from "bun:test";
import { validatedContentType } from "./resource-content-type";

const pngBytes = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("validatedContentType", () => {
  it("uses a recognized image signature when OSS returns the wrong content type", () => {
    expect(
      validatedContentType(
        "image",
        "application/json",
        pngBytes,
        "https://oss.example.com/demo.png",
      ),
    ).toBe("image/png");
  });

  it("does not trust an image file extension when the body is not an image", () => {
    expect(() =>
      validatedContentType(
        "image",
        "application/json",
        Buffer.from('{"error":"not an image"}'),
        "https://oss.example.com/demo.png",
      ),
    ).toThrow("图片资源的 Content-Type 必须为 image/*");
  });

  it("continues to reject SVG images", () => {
    expect(() =>
      validatedContentType(
        "image",
        "image/svg+xml",
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      ),
    ).toThrow("自动重新上传不支持可能包含脚本的 SVG 图片");
  });
});
