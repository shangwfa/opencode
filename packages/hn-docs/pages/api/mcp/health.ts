import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ status: "error" });
  }
  return res
    .status(200)
    .json({ status: "ok", service: "book-v3-mcp", version: "1.1.0" });
}
