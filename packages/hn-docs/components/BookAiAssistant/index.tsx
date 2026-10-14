import dynamic from "next/dynamic";
import { useRouter } from "next/router";

import { env } from "@/utils/env";

const AiAssistant = dynamic(
  () => import("@xybot/ai-assistant-sdk").then((module) => module.AiAssistant),
  { ssr: false },
);

export default function BookAiAssistant() {
  const router = useRouter();
  const { brandCode, languageCode } = router.query;

  if (
    !router.isReady ||
    typeof brandCode !== "string" ||
    typeof languageCode !== "string"
  ) {
    return null;
  }

  const hiddenBrands = (env.AI_ASSISTANT_HIDDEN_BRANDS ?? "")
    .split(",")
    .map((brand) => brand.trim())
    .filter(Boolean);

  if (
    env.ENV === "private" ||
    hiddenBrands.includes(brandCode) ||
    (typeof window !== "undefined" && window.innerWidth < 800)
  ) {
    return null;
  }

  const KNOWLEDGE_BASE = `kb_${brandCode}_${languageCode}`;

  return (
    <AiAssistant
      baseUrl={env.COLLEGE_BASE_URL}
      apiBaseUrl={env.YDDOC_API_URL}
      runtimeContext={{
        source: "yddoc",
        knowledgeBase: KNOWLEDGE_BASE,
        brandCode,
        languageCode,
      }}
      agentConfig={{
        mode: "generic",
        knowledgeBaseIds: KNOWLEDGE_BASE,
        model: "google/gemini-3-flash",
      }}
      floatProps={{
        defaultOpen: false,
        right: 24,
        bottom: 24,
        zIndex: 1000,
      }}
    />
  );
}
