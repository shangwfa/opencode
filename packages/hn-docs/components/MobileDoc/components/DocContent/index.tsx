import React, { useEffect, useState } from "react";
import { useRouter } from "next/router";

import SearchPortalV2 from "@/components/SearchPortalV2";
// import SearchResult from "@/components/SearchResult";
import YDBreadcrumb from "@/components/YDBreadcrumb";

import { useDefaultOpenKeys, useIsYdBrowser, usePcMobile } from "@/hooks";
import { getUrlParams, ShowPublishErrorWindow, recordLog } from "@/utils";
import { useSharedData } from "@/context/SharedDataContext";
import { RequestSource } from "@/api/index.d";
import { queryMenusTrees } from "@/api/customer";
import { env } from "@/utils/env";
import { getLang } from "@/utils/getLang";

import RightBlackIcon from "/static/img/right-black.svg";

interface Props {
  collapseMenu: boolean;
  onCollapseMenu: (s: boolean) => void;
  style: React.CSSProperties;
  children: React.ReactNode;
  searchVal?: string;
}

interface OpenKeys {
  name: string;
  id?: string;
}

export default (props: Props) => {
  const { collapseMenu, onCollapseMenu, style, searchVal } = props;
  const [openKeys, setOpenKeys] = useState([] as OpenKeys[]);
  const isMobile = usePcMobile();
  const isYd = useIsYdBrowser();
  const [source, setSource] = useState("");

  const [keywords, setKeywords] = useState("");

  const { sharedData } = useSharedData();
  const { menus, id } = sharedData;

  const router = useRouter();
  // 直接从 router.query 获取 menuId
  const menuId = router.query.menuId as string | undefined;
  const searchData = router.query.keywords as string;

  const { brandCode, from, param, languageCode } = router.query;

  useEffect(() => {
    if (id || menuId) {
      queryMenusTrees({
        brandCode: brandCode as string,
        languageCode: languageCode as string,
      }).then((res) => {
        const keys: OpenKeys[] = useDefaultOpenKeys(res.data, menuId || id);
        setOpenKeys(keys);
      });
    } else {
      setOpenKeys([]);
    }
  }, [id, menuId]);

  useEffect(() => {
    setKeywords(searchData);
  }, [searchData]);

  useEffect(() => {
    setSource(decodeURIComponent(getUrlParams("source")));
  }, []);

  const onKeyChange = (val: string) => {
    setKeywords(val);
  };

  return (
    <div
      style={{
        ...style,
        transition: isMobile ? "none" : "all 0.5s ease-in-out",
      }}
      className={`flex-1 w-full ${!isMobile && "pr-[25px]"}`}
    >
      {isMobile && (
        <SearchPortalV2 keywords={keywords} onKeyChange={onKeyChange} />
      )}
      <div
        className="overflow-auto absolute top-[82px] scrollbar-custom w-full"
        style={{
          height: `calc(100% - 104px)`,
        }}
        id="scroll-container"
      >
        <div className="w-full px-[16px] text-gray-700 text-base min-h-full flex">
          <div className="bg-[white] rounded-[8px] px-[14px] py-[20px] min-h-full w-full">
            <div className={`${isMobile ? "" : "pl-[100px]"}`}>
              <YDBreadcrumb breadcrumbData={openKeys} />
              <div className="mt-[26px]"> {props.children}</div>
            </div>
          </div>
        </div>
        {env.ENV !== "international" &&
          (isYd ? (
            <div className="clear-both mt-[20px] py-[40px]">
              <p className="m-0 mb-[10px] text-[#1f2633] text-base font-semibold font-['PingFang SC'] leading-[25px] text-center">
                没有找到想要的内容？
              </p>
              <span className="block text-[#1f2633] text-[13px] font-normal font-['PingFang SC'] leading-none text-center">
                {getLang("ask_questions_in_the_community_and_technical")}
              </span>
              <div
                onClick={() => {
                  const curSource =
                    source ||
                    document.getElementsByTagName("h1")[0].textContent;
                  ShowPublishErrorWindow(source);
                  recordLog(curSource, "question");
                }}
                className="flex items-center justify-center w-[90px] h-[32px] mx-auto mt-[24px] text-white leading-[32px] bg-[#232a37] rounded-lg cursor-pointer pl-[5px] text-[12px] hover:opacity-80 transition duration-300"
                data-bury-id="a759338c-6157-44be-92de-2aa6470286c2"
              >
                {getLang("quick_questions")}
                <RightBlackIcon className="ml-[2px]" />
              </div>
            </div>
          ) : (
            <>
              {brandCode === RequestSource.RPA ? (
                <div className="flex items-center clear-both h-[60px] px-[55px] border-t border-solid border-gray-200 text-sm">
                  {getLang("the_problem_has_not_been_solved_yet")}
                  <a
                    href="/community/homePage/?helpcenter"
                    target="_blank"
                    className="text-blue-500"
                  >
                    {getLang("ask_questions_in_the_community")}
                  </a>
                </div>
              ) : null}
            </>
          ))}
      </div>
    </div>
  );
};
