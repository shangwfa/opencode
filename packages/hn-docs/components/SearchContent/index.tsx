import React, { useState, useEffect } from "react";
import { Tabs, Breadcrumb } from "antd";
import {
  MenuUnfoldOutlined,
  MenuFoldOutlined,
  RightOutlined,
} from "@ant-design/icons";
import Image from "next/image";
import { useRouter } from "next/router";
import { sendBuryById } from "@xybot/bury";

import { useIsYdBrowser, usePcMobile, useSearchQuery } from "@/hooks";
import InfiniteScroll from "react-infinite-scroll-component";
import { recordLog, ShowPublishErrorWindow } from "@/utils";
import { useJumpUrl } from "@/hooks/jump-url";
import { RequestSource } from "@/api/index.d";
import { getLang } from "@/utils/getLang";
import { env } from "@/utils/env";

import empty from "/static/img/search-empty.png";

import "./index.css";

const { TabPane } = Tabs;

interface IProps {
  style?: React.CSSProperties;
  collapseMenu?: boolean;
  onCollapseMenu?: (s: boolean) => void;
  keywords: string;
  noPadding?: boolean;
  dataSource?: {
    url: string;
    source: string;
    sourceName: string;
    title: string;
    body: string;
    tag: string;
    score: number;
  }[];
}

export const SearchContent: React.FC<IProps> = (p) => {
  const {
    keywords,
    style,
    onCollapseMenu,
    collapseMenu,
    noPadding = false,
  } = p;
  const isMobile = usePcMobile();
  const [qryParam, setQryParam] = useState({
    key: "",
    source:
      env.ENV == "private" ||
      env.ENV == "international"
        ? "help_doc"
        : "",
    page: 1,
  });
  const { dataSource, total, isAll } = useSearchQuery(qryParam);
  const isYd = useIsYdBrowser();
  const jumpUrl = useJumpUrl();
  const router = useRouter();
  const { brandCode, from } = router.query;

  useEffect(() => {
    setQryParam({
      key: keywords,
      page: 1,
      source:
        env.ENV == "private" ||
        env.ENV == "international"
          ? "help_doc"
          : "",
    });
  }, [keywords]);

  const clickItem = (item: any, index: number) => {
    const params = {
      keyword: keywords,
      source: "search-click",
      tab: item.source,
      openTarget: item.title,
      index,
      answer: dataSource?.slice(0, 5)?.map((item) => item.title) ?? [],
    };
    sendBuryById("39c73c54-45a3-4b47-85b6-73f08d0aa9d4", params);
    recordLog(keywords);
    const url =
      item.source == "forum"
        ? decodeURIComponent(item.url)
        : decodeURIComponent(item.url) +
          `?source=${keywords}${from ? `&from=${from}` : ""}`;
    window.open(url, item.source === "forum" ? "_blank" : "_self");
  };

  return (
    <div
      className="flex flex-col flex-1 items-start overflow-auto transition-all duration-500 ease-in-out"
      style={{
        paddingLeft: isMobile ? "24px" : "0",
        paddingRight: isMobile ? "24px" : "0",
        ...style,
      }}
    >
      {!isMobile && (
        <div
          className="fixed left-[330px] z-10 flex items-center w-full pt-[18px] pb-[32px] pl-[24px] bg-white transition-all duration-500 ease-in-out "
          style={{
            top: isYd ? "0px" : "81px",
            left: collapseMenu ? "0px" : "331px",
          }}
        >
          {!isMobile && (
            <div
              className="mr-[10px] cursor-pointer"
              onClick={() => onCollapseMenu && onCollapseMenu(!collapseMenu)}
              data-bury-id="c6bdd490-c2cd-4acc-b60c-dd061e5fd3d9"
            >
              {collapseMenu ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            </div>
          )}
          <Breadcrumb separator=">">
            <Breadcrumb.Item href={jumpUrl()}>
              {getLang("home")}
            </Breadcrumb.Item>
            <Breadcrumb.Item>{getLang("search")}</Breadcrumb.Item>
          </Breadcrumb>
        </div>
      )}
      {isMobile && (
        <div className="h-[24px]">
          <Breadcrumb separator=">">
            <Breadcrumb.Item href={jumpUrl()}>
              {getLang("home")}
            </Breadcrumb.Item>
            <Breadcrumb.Item href={jumpUrl("help")}>
              {getLang("help_documents")}
            </Breadcrumb.Item>
            <Breadcrumb.Item>{getLang("search")}</Breadcrumb.Item>
          </Breadcrumb>
        </div>
      )}
      <div
        className={`w-full text-gray-400 font-normal text-sm leading-none uppercase ${!isMobile && "pl-[24px]"}`}
      >
        {env.ENV != "private" && (
          <Tabs
            defaultActiveKey=""
            activeKey={qryParam.source}
            onChange={(e) => {
              setQryParam({
                key: keywords,
                page: 1,
                source: e,
              });
            }}
          >
            {env.ENV !== "international" && (
              <TabPane tab={getLang("all")} key=""></TabPane>
            )}
            <TabPane tab={getLang("documents")} key="help_doc"></TabPane>
            {env.ENV !== "international" &&
              brandCode === RequestSource.RPA && (
                <TabPane tab={getLang("community")} key="forum"></TabPane>
              )}
          </Tabs>
        )}
        {dataSource?.length > 0 && (
          <div className="pt-[24px] overflow-hidden scrollable">
            <InfiniteScroll
              dataLength={dataSource.length}
              hasMore={!isAll}
              loader={getLang("loading")}
              endMessage={
                isYd && env.ENV !== "international" ? (
                  <div className="clear-both mt-[20px] py-[40px] px-[20px]">
                    <p className="mb-8 text-gray-800 font-semibold text-[18px] leading-[25px] text-center">
                      {getLang("more_resources")}
                    </p>
                    <span className="block mt-[4px] text-gray-400 font-normal text-[13px] text-center">
                      {getLang("ask_questions_in_the_community_and_technical")}
                    </span>
                    <div
                      onClick={() => {
                        ShowPublishErrorWindow(keywords);
                        recordLog(keywords, "noResult");
                      }}
                      className="w-[104px] h-[30px] mx-auto mt-[24px] flex items-center justify-center text-white text-center bg-red-500 rounded-md cursor-pointer"
                      data-bury-id="10277ec6-8b24-4718-b55a-0a7b9f6e0fc6"
                    >
                      {getLang("quick_questions")}
                      <RightOutlined className="inline ml-[4px] text-white" />
                    </div>
                  </div>
                ) : (
                  <div className="pb-[22px] text-gray-400 font-normal text-sm text-center">
                    <b>{getLang("you_have_reached_the_end")}</b>
                  </div>
                )
              }
              scrollableTarget="scrollableDiv"
              next={() => {
                setQryParam({
                  ...qryParam,
                  page: qryParam.page + 1,
                });
              }}
            >
              {dataSource?.map((e: any, index: number) => (
                <div
                  key={index}
                  className="px-[8px] py-[12px] rounded-md cursor-pointer hover:bg-gray-100"
                  onClick={() => clickItem(e, index)}
                >
                  <h3
                    className="m-0 overflow-hidden text-gray-800 text-[16px] leading-normal search-content"
                    dangerouslySetInnerHTML={{
                      __html: e.title,
                    }}
                  ></h3>
                  {!!e.body && (
                    <div
                      className="clamp-3"
                      dangerouslySetInnerHTML={{
                        __html: e.body,
                      }}
                    ></div>
                  )}
                  <span
                    className="inline-block h-[16px] mt-[16px] px-[8px] text-gray-400 font-normal text-xs leading-[16px] text-center bg-gray-200 rounded-full"
                    dangerouslySetInnerHTML={{
                      __html: e.tag,
                    }}
                  ></span>
                </div>
              ))}
            </InfiniteScroll>
          </div>
        )}
        {total == 0 && (
          <div className="w-[270px] mx-auto pb-[100px]">
            <Image
              src={empty}
              alt="RPA"
              className="block w-[172px] mx-auto mt-[72px] mb-[15px]"
            />
            <p className="m-0 mb-[8px] text-gray-800 font-semibold text-[18px] leading-[25px] text-center">
              {getLang("more_resources")}
            </p>
            {isYd && env.ENV !== "international" ? (
              <>
                <span className="block text-gray-400 font-normal text-sm leading-none text-center">
                  {getLang("ask_questions_in_the_community_and_technical")}
                </span>
                <div
                  onClick={() => {
                    ShowPublishErrorWindow(keywords);
                    recordLog(keywords, "noResult");
                  }}
                  className="w-[104px] h-[30px] mx-auto mt-[24px] text-white leading-[30px] text-center bg-red-500 rounded-md cursor-pointer pl-[5px] text-[12px]"
                  data-bury-id="917d7a46-1115-4109-8c5a-46bccadcadcd"
                >
                  {getLang("quick_questions")}
                  <RightOutlined className="inline ml-[4px] text-white" />
                </div>
              </>
            ) : (
              <span className="block text-gray-400 font-normal text-sm leading-none text-center">
                {getLang("please_try_another_search_term")}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default SearchContent;
