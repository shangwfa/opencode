import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSearchParams } from "next/navigation";

import HtmlHead from "@/components/HtmlHead";

export default () => {
  const router = useRouter();
  const searchParams = useSearchParams();

  // 兜底客户端不传产品code情况
  useEffect(() => {
    // 保留原有的查询参数
    const queryString = searchParams?.toString();
    const targetUrl = queryString ? `/rpa?${queryString}` : "/rpa";
    router.push(targetUrl);
  }, [searchParams]);

  return (
    <>
      <HtmlHead />
    </>
  );
};
