#!/usr/bin/env node
/**
 * 从 Figma MCP 的 localhost URL 批量下载图片/图标资源。
 *
 * Figma MCP 返回的图片/图标以 localhost URL 形式提供（如 http://localhost:3845/...）。
 * 本脚本会：文件名转为 kebab-case；扩展名优先按响应 Content-Type 确定（image/png→.png、
 * image/svg+xml→.svg 等），其次按文件魔数检测，无法识别时才使用 --ext（默认 .svg）。
 * 因此 PNG 位图会正确保存为 .png，不会误存为 .svg。
 *
 * 用法:
 *   # 通过 JSON 字符串传入资源清单
 *   node download_figma_assets.mjs \
 *     --output-dir src/pages/dashboard/assets \
 *     --assets '[{"url":"http://localhost:3845/img/abc","name":"IconSearch"}]'
 *
 *   # 通过 JSON 文件传入资源清单
 *   node download_figma_assets.mjs \
 *     --output-dir src/pages/dashboard/assets \
 *     --assets-file assets.json
 *
 *   # 指定扩展名（仅在不识别类型时使用，默认 .svg）
 *   node download_figma_assets.mjs \
 *     --output-dir src/assets \
 *     --ext .png \
 *     --assets '[{"url":"http://localhost:3845/img/abc","name":"photo-bg"}]'
 *
 * 资源清单格式 (JSON Array):
 *   [
 *     { "url": "http://localhost:3845/...", "name": "IconSearch" },
 *     { "url": "http://localhost:3845/...", "name": "arrow-right" }
 *   ]
 *
 * 无外部依赖，仅使用 Node.js 内置模块。
 */

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { parseArgs } from "node:util";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

// ─── CLI 参数解析 ───

const { values: args } = parseArgs({
  options: {
    "output-dir": { type: "string" },
    assets: { type: "string" },
    "assets-file": { type: "string" },
    ext: { type: "string", default: ".svg" },
    timeout: { type: "string", default: "30" },
    "no-kebab": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (args.help) {
  console.log(`用法: node download_figma_assets.mjs --output-dir <dir> --assets '<json>' [选项]

选项:
  --output-dir   资源保存目录（必填，不存在则自动创建）
  --assets       资源清单 JSON 字符串: [{"url":"...","name":"..."},...]
  --assets-file  资源清单 JSON 文件路径（与 --assets 二选一）
  --ext          文件扩展名（默认 .svg）
  --timeout      单个下载超时秒数（默认 30）
  --no-kebab     不转换文件名为 kebab-case，保留原名
  -h, --help     显示帮助

示例:
  node download_figma_assets.mjs \\
    --output-dir src/assets \\
    --assets '[{"url":"http://localhost:3845/img/abc","name":"IconSearch"}]'`);
  process.exit(0);
}

// ─── 工具函数 ───

function toKebabCase(name) {
  return name
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * 根据 Content-Type 返回合适扩展名，未知则返回 null。
 */
function extFromContentType(contentType) {
  if (!contentType || typeof contentType !== "string") return null;
  const m = contentType.split(";")[0].trim().toLowerCase();
  if (m === "image/svg+xml") return ".svg";
  if (m === "image/png") return ".png";
  if (m === "image/jpeg" || m === "image/jpg") return ".jpg";
  if (m === "image/webp") return ".webp";
  if (m === "image/gif") return ".gif";
  return null;
}

/**
 * 根据 PNG/JPEG 等魔数检测扩展名（无 Content-Type 时兜底）。
 */
function extFromBuffer(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return ".jpg";
  if (buf[2] === 0x57 && buf[3] === 0x45 && buf[4] === 0x42) return ".webp"; // WEBP
  return null;
}

function download(url, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const requester = url.startsWith("https") ? httpsRequest : httpRequest;
    const req = requester(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        download(res.headers.location, timeout).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const contentType = res.headers["content-type"];
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const data = Buffer.concat(chunks);
        resolve({ data, contentType });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error("超时"));
    });
    req.end();
  });
}

function parseAssets(raw) {
  let assets;
  try {
    assets = JSON.parse(raw);
  } catch (e) {
    console.error(`[错误] 资源清单不是有效的 JSON: ${e.message}`);
    process.exit(1);
  }

  if (!Array.isArray(assets)) {
    console.error("[错误] 资源清单必须是 JSON 数组");
    process.exit(1);
  }

  for (let i = 0; i < assets.length; i++) {
    const item = assets[i];
    if (typeof item !== "object" || item === null) {
      console.error(`[错误] 第 ${i + 1} 项不是对象`);
      process.exit(1);
    }
    if (!item.url || !item.name) {
      console.error(`[错误] 第 ${i + 1} 项缺少 "url" 或 "name" 字段`);
      process.exit(1);
    }
  }

  return assets;
}

// ─── 主流程 ───

async function main() {
  const outputDir = args["output-dir"];
  if (!outputDir) {
    console.error("[错误] 必须提供 --output-dir");
    process.exit(1);
  }

  if (!args.assets && !args["assets-file"]) {
    console.error("[错误] 必须提供 --assets 或 --assets-file");
    process.exit(1);
  }

  let raw;
  if (args["assets-file"]) {
    try {
      raw = readFileSync(args["assets-file"], "utf-8");
    } catch (e) {
      console.error(`[错误] 无法读取文件 ${args["assets-file"]}: ${e.message}`);
      process.exit(1);
    }
  } else {
    raw = args.assets;
  }

  const assets = parseAssets(raw);
  if (assets.length === 0) {
    console.log("资源清单为空，无需下载。");
    return;
  }

  let ext = args.ext || ".svg";
  if (!ext.startsWith(".")) ext = `.${ext}`;
  const timeoutMs = (parseInt(args.timeout, 10) || 30) * 1000;
  const noKebab = args["no-kebab"];

  mkdirSync(outputDir, { recursive: true });

  console.log("--- Figma 资源下载 ---");
  console.log(`目标目录: ${outputDir}`);
  console.log(`资源数量: ${assets.length}`);
  console.log(`文件格式: ${ext}`);
  console.log();

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < assets.length; i++) {
    const { url, name } = assets[i];
    let filename = noKebab ? name : toKebabCase(name);
    const base = filename.replace(/\.[a-z0-9]+$/i, "") || filename;

    try {
      const { data, contentType } = await download(url, timeoutMs);
      const resolvedExt =
        extFromContentType(contentType) ?? extFromBuffer(data) ?? ext;
      const finalFilename = `${base}${resolvedExt}`;
      const dest = join(outputDir, finalFilename);

      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, data);
      const sizeKB = (data.length / 1024).toFixed(1);
      console.log(`  [${i + 1}/${assets.length}] OK    ${finalFilename}  (${sizeKB} KB)`);
      successCount++;
    } catch (e) {
      console.log(`  [${i + 1}/${assets.length}] FAIL  ${base}${ext}  (${e.message})`);
      failCount++;
    }
  }

  console.log();
  console.log(`--- 完成: ${successCount} 成功, ${failCount} 失败 ---`);

  if (failCount > 0) {
    console.error(
      `\n[警告] 有 ${failCount} 个资源下载失败，请检查 URL 是否有效或 Figma 桌面端是否运行。`
    );
    process.exit(1);
  }
}

main();
