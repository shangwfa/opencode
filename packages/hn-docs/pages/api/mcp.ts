import type { NextApiRequest, NextApiResponse } from "next";
import { handleMcpRequest } from "@/lib/book-open/mcp";

export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
};

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return handleMcpRequest(req, res);
}
