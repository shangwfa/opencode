import { NextRequest, NextResponse } from "next/server";
import * as db from "@/lib/db";

const SAAS_URL = process.env.NEXT_PUBLIC_OPENCODE_SAAS_URL ?? "http://localhost:14096";

async function createSaasSession() {
  const response = await fetch(`${SAAS_URL}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new Error("SaaS session create failed: " + response.status);
  return (await response.json()) as { id: string; title?: string };
}

async function deleteSaasSession(saasSessionId: string) {
  await fetch(`${SAAS_URL}/session/${saasSessionId}`, { method: "DELETE" }).catch(() => {});
}

async function syncSaasTitle(record: db.ThreadRecord) {
  const response = await fetch(`${SAAS_URL}/session/${record.saasSessionId}`).catch(() => null);
  if (!response?.ok) return record;
  const session = (await response.json()) as { title?: string };
  if (!session.title || session.title === record.title) return record;
  return db.syncThreadTitle(record.id, session.title) ?? record;
}

function toThreadShape(record: db.ThreadRecord) {
  return {
    id: record.id,
    title: record.title || record.saasSessionId,
    createdAt: record.createdAt,
  };
}

function toThreadDetail(record: db.ThreadRecord) {
  return {
    ...toThreadShape(record),
    saasSessionId: record.saasSessionId,
  };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  if (!path || path.length === 0) return NextResponse.json({ error: "invalid path" }, { status: 400 });

  if (path[0] === "get") {
    if (path.length === 1) {
      const records = await Promise.all(db.listThreadRecords().map(syncSaasTitle));
      return NextResponse.json({ threads: records.map(toThreadShape) });
    }
    const record = db.getThreadRecord(path[1]);
    if (!record) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(toThreadDetail(await syncSaasTitle(record)));
  }

  return NextResponse.json({ error: "not found" }, { status: 404 });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  if (!path || path.length === 0) return NextResponse.json({ error: "invalid path" }, { status: 400 });

  if (path[0] === "create") {
    const saasSession = await createSaasSession();
    const record = db.createThreadRecord(saasSession.id, saasSession.title ?? "");
    return NextResponse.json(toThreadShape(record));
  }

  if (path[0] === "abort" && path.length === 2) {
    const record = db.getThreadRecord(path[1]);
    if (!record) return NextResponse.json({ error: "not found" }, { status: 404 });
    const response = await fetch(`${SAAS_URL}/session/${record.saasSessionId}/abort`, { method: "POST" });
    if (!response.ok) return NextResponse.json({ error: "SaaS session abort failed" }, { status: response.status });
    return new NextResponse(null, { status: 204 });
  }

  return NextResponse.json({ error: "not found" }, { status: 404 });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  if (!path || path.length !== 2 || path[0] !== "update") {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }
  const body = await req.json();
  const record = db.updateThreadRecord(path[1], body.title ?? "");
  if (!record) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(toThreadShape(record));
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  if (!path || path.length !== 2 || path[0] !== "delete") {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }
  const record = db.getThreadRecord(path[1]);
  if (record) {
    db.deleteThreadRecord(path[1]);
    await deleteSaasSession(record.saasSessionId);
  }
  return new NextResponse(null, { status: 204 });
}
