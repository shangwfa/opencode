import { readFileSync } from "fs";
import { join } from "path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const content = readFileSync(join(process.cwd(), "src/generated/system-prompt.txt"), "utf-8");
  return new NextResponse(content, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}