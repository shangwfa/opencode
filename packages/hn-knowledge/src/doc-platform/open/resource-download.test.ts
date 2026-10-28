import { describe, expect, it, vi } from "bun:test";
import type { LookupAddress, LookupOptions } from "node:dns";
import type { LookupFunction } from "node:net";
import {
  createPinnedLookup,
  isDownloadAddressAllowed,
  isBlockedResourceAddress,
} from "./resource-download";

type RuntimeLookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

type RuntimeLookup = (
  hostname: string,
  options: LookupOptions,
  callback: RuntimeLookupCallback,
) => void;

describe("resource download address policy", () => {
  it("blocks private and loopback IPv4 addresses", () => {
    expect(isBlockedResourceAddress("127.0.0.1")).toBe(true);
    expect(isBlockedResourceAddress("10.1.2.3")).toBe(true);
    expect(isBlockedResourceAddress("169.254.169.254")).toBe(true);
  });

  it("blocks local IPv6 addresses", () => {
    expect(isBlockedResourceAddress("::1")).toBe(true);
    expect(isBlockedResourceAddress("fd00::1")).toBe(true);
  });

  it("allows public addresses", () => {
    expect(isBlockedResourceAddress("8.8.8.8")).toBe(false);
    expect(isBlockedResourceAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("allows private addresses only for trusted HTTPS resource hosts", () => {
    const trusted = new URL(
      "https://winrobot-pub-a.oss-cn-hangzhou.aliyuncs.com/resource.png",
    );

    expect(isDownloadAddressAllowed(trusted, "100.118.1.2")).toBe(true);
    expect(isDownloadAddressAllowed(trusted, "10.1.2.3")).toBe(true);
    expect(
      isDownloadAddressAllowed(
        new URL("https://untrusted.example.com/resource.png"),
        "100.118.1.2",
      ),
    ).toBe(false);
    expect(
      isDownloadAddressAllowed(
        new URL(
          "http://winrobot-pub-a.oss-cn-hangzhou.aliyuncs.com/resource.png",
        ),
        "100.118.1.2",
      ),
    ).toBe(false);
  });

  it("still blocks loopback, link-local, reserved, and IPv6 addresses", () => {
    const trusted = new URL(
      "https://xybot-oss-1302949341.cos.ap-shanghai.myqcloud.com/resource.mp4",
    );

    expect(isDownloadAddressAllowed(trusted, "127.0.0.1")).toBe(false);
    expect(isDownloadAddressAllowed(trusted, "169.254.169.254")).toBe(false);
    expect(isDownloadAddressAllowed(trusted, "203.0.113.10")).toBe(false);
    expect(isDownloadAddressAllowed(trusted, "fd00::1")).toBe(false);
  });
});

describe("pinned resource lookup", () => {
  const resolved = { address: "203.0.113.10", family: 4 } as const;

  function runtimeLookup(): RuntimeLookup {
    return createPinnedLookup(resolved) as LookupFunction as RuntimeLookup;
  }

  it("returns the legacy single-address callback shape", () => {
    const callback = vi.fn<RuntimeLookupCallback>();

    runtimeLookup()("resource.example.com", { all: false }, callback);

    expect(callback).toHaveBeenCalledWith(null, resolved.address, 4);
  });

  it("returns an address array when Node requests all addresses", () => {
    const callback = vi.fn<RuntimeLookupCallback>();

    runtimeLookup()("resource.example.com", { all: true }, callback);

    expect(callback).toHaveBeenCalledWith(null, [resolved]);
  });
});
