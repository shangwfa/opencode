import type { NextApiRequest, NextApiResponse } from "next";
import { handleOpenRest } from "@/lib/book-open/rest";

export const config = {
  api: {
    bodyParser: { sizeLimit: "3mb" },
    responseLimit: "6mb",
  },
};

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return handleOpenRest(req, res);
}
