import React, { useState, useEffect } from "react";
import { Breadcrumb } from "antd";
import { MenuUnfoldOutlined, MenuFoldOutlined } from "@ant-design/icons";
import { useRouter } from "next/router";
import InfiniteScroll from "react-infinite-scroll-component";

import { useIsYdBrowser, usePcMobile, useSearchQuery } from "@/hooks";
import { useJumpUrl } from "@/hooks/jump-url";
import { getLang } from "@/utils/getLang";
import { env } from "@/utils/env";

import AiSearch from "@/components/AiSearch";
import Empty from "./components/Empty";
import SearchItem from "./components/SearchItem";

import ReDown from "@/static/img/re-down.svg";

import "./index.css";

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

const CommunityRelated = (props) => {
  const { keywords, allTotal } = props;
  const [isExpand, setIsExpand] = useState(false);

  const onExpand = () => {
    setIsExpand(!isExpand);
  };

  const [qryParam, setQryParam] = useState({
    key: "",
    source:
      env.ENV == "private" || env.ENV == "international" ? "help_doc" : "",
    page: 1,
  });
  const { dataSource, total, isAll } = useSearchQuery(qryParam);

  useEffect(() => {
    if (total >= allTotal) {
      setIsExpand(true);
    } else {
      setIsExpand(false);
    }
  }, [total, allTotal]);

  useEffect(() => {
    setQryParam({
      key: keywords,
      page: 1,
      source: "forum",
    });
  }, [keywords]);

  return (
    <div>
      {total ? (
        <div
          className="text-[#9ea6b8] text-[13px] font-normal inline-flex items-center px-[8px] py-[6px] rounded hover:text-[#1f2633] hover:bg-[#f5f7fa] cursor-pointer selected-community transition duration-300"
          onClick={onExpand}
          style={{
            marginTop: allTotal > total ? "24px" : 0,
            marginBottom: isExpand ? 0 : "24px",
          }}
          data-bury-id="9c42acef-4005-4fd2-966f-fc9816525027"
        >
          <ReDown className="mr-[8px]" />
          {getLang("view_relevant_questions_within_the_community")} ({total})
        </div>
      ) : null}
      <InfiniteScroll
        dataLength={dataSource.length}
        hasMore={!isAll}
        loader=""
        endMessage={<div></div>}
        scrollableTarget="scroll-container"
        next={() => {
          setQryParam({
            ...qryParam,
            page: qryParam.page + 1,
          });
        }}
      >
        {isExpand && <SearchItem list={dataSource} keywords={keywords} />}
      </InfiniteScroll>
    </div>
  );
};

const OfficialRelated = (props) => {
  const { keywords } = props;
  const [qryParam, setQryParam] = useState({
    key: "",
    source:
      env.ENV == "private" || env.ENV == "international" ? "help_doc" : "",
    page: 1,
  });
  const { dataSource, total, isAll } = useSearchQuery(qryParam);

  useEffect(() => {
    setQryParam({
      key: keywords,
      page: 1,
      source: "help_doc",
    });
  }, [keywords]);

  return <SearchItem list={dataSource} keywords={keywords} />;
};

export const SearchResult: React.FC<IProps> = (p) => {
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
      env.ENV == "private" || env.ENV == "international" ? "help_doc" : "",
    page: 1,
  });
  const { total, isLoading } = useSearchQuery(qryParam);

  const isYd = useIsYdBrowser();
  const jumpUrl = useJumpUrl();
  const router = useRouter();

  const [searchValue, setSearchValue] = useState<string>(keywords);

  // 直接从 router.query 获取 menuId
  const menuId = router.query.menuId as string | undefined;
  const searchData = router.query.keywords;

  useEffect(() => {
    if (keywords) {
      setSearchValue(keywords);
    }
  }, [keywords]);

  useEffect(() => {
    if (searchValue && searchData && searchData !== keywords && !menuId) {
      setSearchValue(searchData as string);
    }
  }, [searchData]);

  useEffect(() => {
    setQryParam({
      key: searchValue,
      page: 1,
      source:
        env.ENV == "private" || env.ENV == "international" ? "help_doc" : "",
    });
  }, [searchValue]);

  return (
    <div
      className="flex flex-col flex-1 items-start overflow-auto"
      style={{
        marginLeft: isMobile ? "16px" : "0",
        marginRight: isMobile ? "16px" : "0",
        paddingLeft: isMobile ? "14px" : "0",
        paddingRight: isMobile ? "14px" : "0",
        backgroundColor: isMobile ? "#fff" : "",
        borderRadius: isMobile ? "8px" : "0",
        paddingTop: "20px",
        minHeight: `calc(100% - ${isYd ? "2px" : "96px"})`,
      }}
    >
      {isMobile && (
        <div className="text-[#9ea6b8] text-[13px] font-normal font-['PingFang SC'] leading-normal mb-[18px]">
          {getLang("search_found")}
          {total} {getLang("returns")}
        </div>
      )}
      {isMobile && <AiSearch keywords={searchValue} />}
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
              data-bury-id="cc4b3745-7637-44eb-ba6f-4679701701f6"
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
      <div
        className={`w-full text-gray-400 font-normal text-sm leading-none uppercase ${!isMobile && "pl-[24px]"}`}
      >
        <OfficialRelated keywords={searchValue} />
        <CommunityRelated keywords={searchValue} allTotal={total} />
        {/* {total === 0 && !isLoading && <Empty keywords={searchValue} />} */}
        {!isLoading && <Empty keywords={searchValue} isEmptyImg={false} />}
      </div>
    </div>
  );
};

export default SearchResult;
