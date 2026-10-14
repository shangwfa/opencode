import React, { useEffect, useState } from "react";
import { useRouter } from "next/router";

import SearchPortalV2 from "@/components/SearchPortalV2";
import SearchResult from "@/components/SearchResult";
import MobileDoc from "@/components/MobileDoc";

import { useIsYdBrowser } from "@/hooks";

interface IProps {
  keywords: string;
  onKeyChange: (key: string) => void;
}

export const MobileSearch: React.FC<IProps> = (p) => {
  const isYd = useIsYdBrowser();
  const { keywords, onKeyChange } = p;

  const [isMenuId, setIsMenuId] = useState(false);
  const router = useRouter();
  // 直接从 router.query 获取 menuId
  const menuId = router.query.menuId as string | undefined;

  useEffect(() => {
    setIsMenuId(!!menuId);
  }, [menuId]);

  return (
    <>
      {isMenuId && menuId && (
        <div
          className="absolute w-full overflow-auto scrollbar-custom"
          id="scroll-container"
          style={{
            height: `calc(100%)`,
          }}
        >
          <MobileDoc id={menuId} />
        </div>
      )}

      <>
        <div
          style={{
            display: isMenuId ? "none" : "block",
          }}
        >
          <SearchPortalV2 keywords={keywords} onKeyChange={onKeyChange} />
          <div
            className="absolute top-[81px] w-full overflow-auto scrollbar-custom"
            id="scroll-container"
            style={{
              height: `calc(100% - 98px)`,
            }}
          >
            <SearchResult keywords={keywords} noPadding={false} />
          </div>
        </div>
      </>
    </>
  );
};

export default MobileSearch;
