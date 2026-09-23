export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const dir = url.searchParams.get("dir");
  if (!dir) return new Response("missing dir param", { status: 400 });

  const saasUrl = process.env.OPENCODE_SAAS_URL ?? "http://localhost:14096";

  const saasRes = await fetch(`${saasUrl}/event`, {
    headers: { "x-opencode-directory": dir },
  });

  if (!saasRes.ok || !saasRes.body) {
    return new Response("SSE upstream failed", { status: 502 });
  }

  return new Response(saasRes.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}