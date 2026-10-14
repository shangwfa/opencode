import type { NextApiRequest, NextApiResponse } from "next";
import { bookOpenApiDocument } from "@/lib/book-open/openapi";
import { env } from "@/utils/env";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ code: 405, message: "Method not allowed" });
  }
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.status(200).json({
    ...bookOpenApiDocument,
    servers: [{ url: `${env.BASE_PATH}/api/open/v1` }],
  });
}
