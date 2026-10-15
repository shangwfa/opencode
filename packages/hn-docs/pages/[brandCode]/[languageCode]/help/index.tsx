import React, { useEffect, useState } from "react";
import { useRouter } from "next/router";

import Menu from "@/components/Menu";
import SearchPortal from "@/components/SearchPortal";
import SearchPortalV2 from "@/components/SearchPortalV2";
import SearchContent from "@/components/SearchContent";
import HtmlHead from "@/components/HtmlHead";
import PcMenu from "@/components/PcMenu";
import RightContent from "@/components/RightContent";
import SearchResult from "@/components/SearchResult";
import MobileBg from "@/components/MobileBg";
import MobileDoc from "@/components/MobileDoc";

import { usePcMobile, useIsYdBrowser, useClientVersion } from "@/hooks";

export default (props) => {
  const isMobile = usePcMobile();
  const isYd = useIsYdBrowser();
  const { version, isLoading } = useClientVersion();
  const [keywords, setKeywords] = useState("");
  const [collapseMenu, setCollapseMenu] = useState(false);
  const router = useRouter();
  const menuId = router.query.menuId as string | undefined;
  const searchData = router.query.keywords as string;

  useEffect(() => {
    setKeywords(searchData);
  }, [searchData]);

  const onKeyChange = (val: string) => {
    setKeywords(val);
  };
  const onCollapse = (e: boolean) => {
    setCollapseMenu(e);
  };

  return (
    <>
      <HtmlHead />
      {!isLoading && (
        <>
          {isMobile || version ? (
            <>
              {version ? (
                <MobileBg>
                  {!menuId && (
                    <SearchPortalV2
                      keywords={keywords}
                      onKeyChange={onKeyChange}
                    />
                  )}
                  {menuId && (
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
                  <div
                    className="absolute w-full overflow-auto scrollbar-custom"
                    id="mobile-container"
                    style={{
                      height: `calc(100% - ${menuId ? 0 : "98px"})`,
                      top: menuId ? 0 : `81px`,
                      display: menuId ? "none" : "block",
                    }}
                  >
                    {!keywords ? (
                      <div className="w-full px-[16px] text-gray-700 text-base grid h-full">
                        <div
                          className={`bg-[white] rounded-[8px] px-[10px] py-[20px] h-full`}
                        >
                          <Menu />
                        </div>
                      </div>
                    ) : (
                      <SearchResult keywords={keywords} noPadding={false} />
                    )}
                  </div>
                </MobileBg>
              ) : (
                <>
                  <SearchPortal keywords={keywords} onKeyChange={onKeyChange} />
                  {!keywords ? (
                    <div className="w-full px-[20px] py-[24px] text-gray-700 text-base bg-white">
                      <div
                        className={`${version || isYd ? "mt-[96px]" : "mt-[146px]"}`}
                      >
                        <Menu />
                      </div>
                    </div>
                  ) : (
                    <SearchContent
                      style={{
                        paddingTop: version || isYd ? "100px" : "160px",
                      }}
                      keywords={keywords}
                      noPadding={false}
                    />
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <PcMenu
                style={{
                  width: collapseMenu ? "0" : "330px",
                  top: isYd ? "0px" : "81px",
                }}
                onKeyChange={onKeyChange}
              />
              <RightContent
                style={{
                  paddingLeft: collapseMenu ? "0px" : "330px",
                  paddingTop: isYd ? "0px" : "76px",
                }}
                collapseMenu={collapseMenu}
                onCollapseMenu={(s) => onCollapse(s)}
                searchVal={keywords}
              >
                <></>
              </RightContent>
            </>
          )}
        </>
      )}
    </>
  );
};
