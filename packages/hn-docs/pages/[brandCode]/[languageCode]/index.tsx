import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import RightContent from "@/components/RightContent";
import Web from "@/components/Web";
import Mobile from "@/components/Mobile";
import HtmlHead from "@/components/HtmlHead";
import PcMenu from "@/components/PcMenu";

import Help from "./help";

import { usePcMobile, useIsYdBrowser } from "@/hooks";
import { init as initBridge, isHybridCloud } from "@/utils/native-bridge";
import { env } from "@/utils/env";

export default (props) => {
  const { referrer } = props;
  const isMobile = usePcMobile();
  const isYd = useIsYdBrowser();
  const [collapseMenu, setCollapseMenu] = useState(false);
  const [keywords, setKeywords] = useState("");
  const [isHybrid, setIsHybrid] = useState(false);

  useEffect(() => {
    getIsHybridCloudFn();
    initDefaultPage();
  }, []);

  const getIsHybridCloudFn = () => {
    initBridge().then(() => isHybridCloud().then((res) => setIsHybrid(res)));
  };

  const router = useRouter();
  const searchParams = useSearchParams();
  const initDefaultPage = () => {
    // FIXME 临时的、国际化文档逻辑，后面应该移除掉
    if (
      env.ENV === "international" &&
      searchParams?.get("brandCode") === "rpa"
    ) {
      router.replace(`/rpa/en-US/introduction?${searchParams?.toString()}`);
    }
  };

  const onCollapse = (e: boolean) => {
    setCollapseMenu(e);
  };

  const onKeyChange = (val: string) => {
    setKeywords(val);
  };

  return (
    <>
      <HtmlHead />
      {env.ENV === "private" && !isHybrid ? (
        <Help />
      ) : isMobile || referrer === "rpa-win" ? (
        <Mobile />
      ) : (
        <>
          {!isMobile && (
            <div>
              <PcMenu
                style={{
                  width: collapseMenu ? "0" : "330px",
                  top: isYd ? "0px" : "81px",
                }}
                onKeyChange={onKeyChange}
              />
            </div>
          )}
          <RightContent
            style={{
              paddingLeft: collapseMenu || isMobile ? "0px" : "330px",
              paddingTop: isYd ? "0px" : "76px",
            }}
            collapseMenu={collapseMenu}
            onCollapseMenu={(s) => onCollapse(s)}
            searchVal={keywords}
          >
            <Web />
          </RightContent>
        </>
      )}
    </>
  );
};

export async function getServerSideProps(context) {
  // 获取查询参数
  const { referrer } = context.query;

  return {
    props: {
      referrer: referrer || "",
    },
  };
}
