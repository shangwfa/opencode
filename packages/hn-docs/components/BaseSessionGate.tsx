import { useEffect, useState, type ReactNode } from "react";
import { baseServiceUrl } from "@/api/docPlatform";

/** 不保存另一份身份或 token；由基础服务读取其现有 Cookie 会话。 */
export default function BaseSessionGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<"loading" | "ready" | "unauthorized" | "error">("loading");
  useEffect(() => {
    let controller: AbortController;
    const check = () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      fetch(`${baseServiceUrl}/api/me`, { credentials: "include", signal: current.signal })
        .then((res) => { if (!current.signal.aborted) setStatus(res.ok ? "ready" : res.status === 401 ? "unauthorized" : "error"); })
        .catch(() => { if (!current.signal.aborted) setStatus("error"); });
    };
    check();
    window.addEventListener("focus", check);
    return () => { controller?.abort(); window.removeEventListener("focus", check); };
  }, []);
  if (status === "ready") return <>{children}</>;
  return <main style={{ maxWidth: 640, margin: "80px auto", padding: 24 }}>
    <h2>文档工作台</h2>
    <p>{status === "loading" ? "正在验证基础服务登录态…" : status === "unauthorized" ? "请先在工作台登录，再返回并刷新本页。" : "基础服务连接失败，请稍后刷新重试。"}</p>
    {status === "unauthorized" ? <a href={`${process.env.NEXT_PUBLIC_HN_APP_URL || "http://localhost:3001"}/#/login`} target="_blank" rel="noreferrer">前往工作台登录 ↗</a> : null}
  </main>;
}
