import { useRouter } from "next/router";
import { useMemo } from "react";
import { env } from "@/utils/env";

export const useJumpUrl = () => {
  const router = useRouter();
  const { brandCode, from, param, languageCode } = router.query;
  const basePath = env.BASE_PATH;

  return useMemo(
    () => (url?: string) => {
      return from
        ? `${basePath}/${brandCode}/${languageCode}${url ? "/" + url : ""}?from=${from}`
        : `${basePath}/${brandCode}/${languageCode}${url ? "/" + url : ""}`;
    },
    [from, brandCode, basePath]
  );
};
