import {
  promises as dns,
  type LookupAddress,
  type LookupOptions,
} from "node:dns";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import axios from "axios";
import { BookOpenError } from "./errors";

const MAX_REDIRECTS = 3;
const blockedAddresses = new BlockList();
const trustedResourceAddresses = new BlockList();
const TRUSTED_RESOURCE_HOSTNAMES = new Set([
  "winrobot-pub-a.oss-cn-hangzhou.aliyuncs.com",
  "xybot-oss-1302949341.cos.ap-shanghai.myqcloud.com",
]);

for (const [network, prefix] of [
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) {
  trustedResourceAddresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

function normalizedAddress(value: string): string {
  return value.replace(/^\[|\]$/g, "").split("%")[0] ?? value;
}

export function isBlockedResourceAddress(value: string): boolean {
  const address = normalizedAddress(value);
  if (address.toLowerCase().startsWith("::ffff:")) return true;
  const family = isIP(address);
  if (family === 4) return blockedAddresses.check(address, "ipv4");
  if (family === 6) return blockedAddresses.check(address, "ipv6");
  return true;
}

function normalizedHostname(value: string): string {
  return value.toLowerCase().replace(/\.$/, "");
}

export function isDownloadAddressAllowed(url: URL, value: string): boolean {
  if (!isBlockedResourceAddress(value)) return true;
  if (
    url.protocol !== "https:" ||
    !TRUSTED_RESOURCE_HOSTNAMES.has(normalizedHostname(url.hostname))
  ) {
    return false;
  }

  const address = normalizedAddress(value);
  return isIP(address) === 4 && trustedResourceAddresses.check(address, "ipv4");
}

async function resolveDownloadAddress(url: URL): Promise<{
  address: string;
  family: 4 | 6;
}> {
  const host = normalizedAddress(url.hostname);
  const literalFamily = isIP(host);
  let addresses: Array<{ address: string; family: 4 | 6 }>;
  try {
    if (literalFamily) {
      addresses = [{ address: host, family: literalFamily as 4 | 6 }];
    } else {
      const resolved = await dns.lookup(host, { all: true, verbatim: true });
      addresses = resolved
        .filter((entry) => entry.family === 4 || entry.family === 6)
        .map((entry) => ({
          address: entry.address,
          family: entry.family as 4 | 6,
        }));
    }
  } catch {
    throw new BookOpenError("VALIDATION_ERROR", "外部资源域名无法解析");
  }

  if (
    addresses.length === 0 ||
    addresses.some((entry) => !isDownloadAddressAllowed(url, entry.address))
  ) {
    throw new BookOpenError(
      "VALIDATION_ERROR",
      "外部资源地址解析到了内网、回环或保留地址，禁止下载",
      safeUrlDetails(url),
    );
  }
  return addresses[0] as { address: string; family: 4 | 6 };
}

function safeUrlDetails(url: URL) {
  return { source: `${url.origin}${url.pathname}`.slice(0, 500) };
}

interface CompatibleLookupCallback {
  (error: NodeJS.ErrnoException | null, address: string, family: number): void;
  (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]): void;
}

export function createPinnedLookup(resolved: LookupAddress): LookupFunction {
  const lookup = (
    _hostname: string,
    options: LookupOptions,
    callback: CompatibleLookupCallback,
  ) => {
    if (options.all) {
      callback(null, [resolved]);
      return;
    }
    callback(null, resolved.address, resolved.family);
  };
  return lookup as LookupFunction;
}

export interface DownloadedResource {
  bytes: Buffer;
  contentType: string;
  sourceUrl: string;
}

export async function downloadPublicResource(
  input: string,
  maxBytes: number,
): Promise<DownloadedResource> {
  let current: URL;
  try {
    current = new URL(input);
  } catch {
    throw new BookOpenError("VALIDATION_ERROR", "外部资源 URL 格式无效");
  }

  for (
    let redirectCount = 0;
    redirectCount <= MAX_REDIRECTS;
    redirectCount += 1
  ) {
    if (!["http:", "https:"].includes(current.protocol)) {
      throw new BookOpenError(
        "VALIDATION_ERROR",
        "外部资源只支持 HTTP 或 HTTPS 地址",
      );
    }
    if (current.username || current.password) {
      throw new BookOpenError(
        "VALIDATION_ERROR",
        "外部资源 URL 不允许包含用户名或密码",
      );
    }
    const resolved = await resolveDownloadAddress(current);
    const lookup = createPinnedLookup(resolved);

    try {
      const response = await axios.get<ArrayBuffer>(current.toString(), {
        timeout: 30_000,
        maxRedirects: 0,
        maxContentLength: maxBytes,
        maxBodyLength: maxBytes,
        responseType: "arraybuffer",
        validateStatus: () => true,
        proxy: false,
        httpAgent: new HttpAgent({ lookup }),
        httpsAgent: new HttpsAgent({ lookup }),
        headers: {
          Accept: "*/*",
          "User-Agent": "book-v3-resource-import/1.0",
        },
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.location;
        if (!location || redirectCount === MAX_REDIRECTS) {
          throw new BookOpenError(
            "VALIDATION_ERROR",
            "外部资源重定向次数过多或缺少目标地址",
            safeUrlDetails(current),
          );
        }
        current = new URL(location, current);
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw new BookOpenError("VALIDATION_ERROR", "下载外部资源失败", {
          ...safeUrlDetails(current),
          sourceStatus: response.status,
        });
      }

      const bytes = Buffer.from(response.data);
      if (bytes.length === 0 || bytes.length > maxBytes) {
        throw new BookOpenError(
          "VALIDATION_ERROR",
          bytes.length === 0 ? "外部资源内容为空" : "外部资源大小超过限制",
          safeUrlDetails(current),
        );
      }
      const contentTypeHeader = response.headers["content-type"];
      const contentType =
        String(contentTypeHeader || "application/octet-stream")
          .split(";", 1)[0]
          ?.trim()
          .toLowerCase() || "application/octet-stream";
      return { bytes, contentType, sourceUrl: current.toString() };
    } catch (error) {
      if (error instanceof BookOpenError) throw error;
      const message = axios.isAxiosError(error) ? error.message : "下载失败";
      throw new BookOpenError(
        "VALIDATION_ERROR",
        message.includes("maxContentLength")
          ? "外部资源大小超过限制"
          : "下载外部资源失败",
        safeUrlDetails(current),
      );
    }
  }

  throw new BookOpenError("VALIDATION_ERROR", "下载外部资源失败");
}
