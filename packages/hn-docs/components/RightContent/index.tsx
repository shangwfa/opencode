import React, { useEffect, useState } from "react";
import { Breadcrumb, Select } from "antd";
import {
  MenuUnfoldOutlined,
  MenuFoldOutlined,
  ArrowLeftOutlined,
  RightOutlined,
} from "@ant-design/icons";
import { useRouter } from "next/router";
import { useSearchParams } from "next/navigation";

import Search from "./components/Search";
import SearchContent from "@/components/SearchContent";

import { useDefaultOpenKeys, useIsYdBrowser, usePcMobile } from "@/hooks";
import { getUrlParams, ShowPublishErrorWindow, recordLog } from "@/utils";
import { useSharedData } from "@/context/SharedDataContext";
import { useJumpUrl } from "@/hooks/jump-url";
import { RequestSource } from "@/api/index.d";
import { getLang } from "@/utils/getLang";
import { env } from "@/utils/env";

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
  const {
    menus,
    id,
    languageCodeList = [],
    docUniqueId,
    languageCode,
    defaultLanguageCode,
  } = sharedData;
  const jumpUrl = useJumpUrl();

  const router = useRouter();
  const { brandCode } = router.query;

  const [defaultLanguage, setDefaultLanguage] = useState<string>(
    defaultLanguageCode || "zh-CN"
  );

  const searchParams = useSearchParams();

  useEffect(() => {
    setDefaultLanguage(languageCode || "zh-CN");
  }, [languageCode]);

  useEffect(() => {
    if (id) {
      const keys: OpenKeys[] = useDefaultOpenKeys(menus, id);
      setOpenKeys(keys);
      setKeywords("");
    } else {
      setOpenKeys([]);
    }
  }, [id]);

  useEffect(() => {
    setKeywords(searchVal || "");
  }, [searchVal]);

  useEffect(() => {
    setSource(decodeURIComponent(getUrlParams("source")));
  }, []);

  const onKeyChange = (val: string) => {
    setKeywords(val);
  };

  const handleChange = (value: string) => {
    setDefaultLanguage(value);
    let url = "";
    const basePath = env.BASE_PATH;
    if (docUniqueId) {
      url = `${basePath}/${sharedData.brandCode}/${value}/${docUniqueId}?${searchParams?.toString()}`;
    } else {
      url = `${basePath}/${sharedData.brandCode}/${value}?${searchParams?.toString()}`;
    }
    window.location.href = url;
  };

  return (
    <div
      style={{
        ...style,
        transition: isMobile ? "none" : "all 0.5s ease-in-out",
      }}
      className={`flex-1 w-full ${!isMobile && "pr-[25px]"}`}
    >
      <div className="fixed top-[24px] right-[20px] z-10">
        {languageCodeList?.length > 1 && !isMobile ? (
          <Select
            value={defaultLanguage}
            style={{ width: 120 }}
            onChange={handleChange}
            options={languageCodeList}
            fieldNames={{ label: "languageName", value: "languageCode" }}
          />
        ) : null}
      </div>
      {isMobile && <Search onKeyChange={onKeyChange} />}
      <div
        className="relative flex pl-[25px] pr-[25px] max-w-[682px] mb-[30px]"
        style={{
          marginTop: isMobile ? "16px" : "36px",
          paddingBottom: isMobile ? 0 : "16px",
          width: isMobile ? "100%" : "calc(100% - 16vw)",
        }}
      >
        {!isMobile && (
          <div
            className="mr-[10px] cursor-pointer"
            onClick={() => onCollapseMenu && onCollapseMenu(!collapseMenu)}
            data-bury-id="c5532e06-915a-4caf-8078-8eee2178a569"
          >
            {collapseMenu ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          </div>
        )}
        {!keywords && (
          <Breadcrumb separator=">">
            <Breadcrumb.Item href={jumpUrl()}>
              {getLang("home")}
            </Breadcrumb.Item>
            {(!id || isMobile) && (
              <Breadcrumb.Item href={jumpUrl("help")}>
                {getLang("help_documents")}
              </Breadcrumb.Item>
            )}
            {openKeys.map((e: any, index: number) => {
              return <Breadcrumb.Item key={index}>{e.name}</Breadcrumb.Item>;
            })}
          </Breadcrumb>
        )}
        {source && !isMobile && (
          <ArrowLeftOutlined
            className="absolute top-[66px] left-[32px] text-xl"
            onClick={() => history.go(-1)}
            data-bury-id="01ece99e-c9f8-4e34-bb9d-8e37c66bae9a"
          />
        )}
      </div>
      {keywords ? (
        <SearchContent
          keywords={keywords}
          onCollapseMenu={onCollapseMenu}
          collapseMenu={collapseMenu}
        />
      ) : (
        <div className={`${isMobile ? "px-[20px] pb-[6px]" : "pl-[100px]"}`}>
          {props.children}
        </div>
      )}
      {env.ENV !== "international" &&
        (isYd ? (
          <div className="clear-both mt-[20px] py-[40px]">
            <p className="m-0 text-center text-gray-700 font-medium text-lg">
              {getLang("more_resources")}
            </p>
            <span className="block mt-4 text-center text-gray-500 font-normal text-sm">
              {getLang("ask_questions_in_the_community_and_technical")}
            </span>
            <div
              className="w-[104px] h-[30px] mx-auto mt-[24px] text-white leading-[30px] text-center bg-red-500 rounded-md cursor-pointer text-[12px] pl-[5px] hover:opacity-80"
              onClick={() => {
                const curSource =
                  source || document.getElementsByTagName("h1")[0].textContent;
                ShowPublishErrorWindow(source);
                recordLog(curSource, "question");
              }}
              data-bury-id="2ccfd24d-2b11-42d2-8ec0-b094b56f9752"
            >
              {getLang("quick_questions")}
              <RightOutlined className="inline ml-[4px] text-white" />
            </div>
          </div>
        ) : (
          <>
            {brandCode === RequestSource.RPA && env.ENV !== "private" ? (
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
  );
};
