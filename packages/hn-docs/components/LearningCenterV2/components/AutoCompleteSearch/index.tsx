"use client";

import React, { useEffect, useState, useCallback } from "react";
import { Input } from "antd";
import { sendBuryById } from "@xybot/bury";

import { getUrlParams, replaceUrlParams, recordLog, debounce } from "@/utils";
import { getLang } from "@/utils/getLang";
import { useSharedData } from "@/context/SharedDataContext";

import { getSearch } from "@/api/public";
import { Version } from "@/api/index.d";

import SearchIcon from "/static/img/search.svg";

import "./index.css";

enum Source {
  Forum = "forum",
  Document = "yd_doc",
}

interface ResultItem {
  title: string;
  url: string;
  officialTag: boolean;
  isAccept: boolean;
  source: Source;
}

interface Props {
  onSetKeywords: (keywords: string) => void;
}

export default (props: Props) => {
  const { onSetKeywords } = props;

  const [keywords, setKeywords] = useState("");
  const [resultList, setResultList] = useState<ResultItem[]>([]);
  const [highlightedIndex, setHighlightedIndex] = useState(-1); // 当前高亮索引
  const [searchValue, setSearchValue] = useState("");
  const [isComposing, setIsComposing] = useState(false);
  const [searchStatus, setSearchStatus] = useState(false);

  const { sharedData } = useSharedData();
  const { envCode } = sharedData;

  const getAnswers = (e: string) => {
    setKeywords(e);
    recordLog(e);
    replaceUrlParams("keywords", e);
    onSetKeywords(e);
  };

  const onSelected = (item: ResultItem, index: number) => {
    const buryParams = {
      keyword: searchValue,
      source: "search-click",
      tab: item.source,
      openTarget: item.title,
      index,
      answer: resultList?.slice(0, 5)?.map((item) => item.title) ?? [],
    };
    sendBuryById("64aac696-fa49-4816-8d05-0067cbae161a", buryParams);
    if (item.source === Source.Forum) {
      window.open(`${item.url}`);
    } else {
      window.location.href = `${item.url}`;
    }
  };

  useEffect(() => {
    const value = getUrlParams("keywords");
    onSetKeywords(value);

    document.addEventListener("click", function (e) {
      const searchInput = document.querySelector(".ant-input");
      const searchResults = document.querySelector(".search-results");
      if (searchInput?.contains(e.target)) {
        setSearchStatus(true);
      }
      if (searchResults) {
        const isClickInside =
          searchResults.contains(e.target) || searchInput?.contains(e.target);
        if (isClickInside) {
          setSearchStatus(true);
        } else {
          setSearchStatus(false);
        }
      }
    });
  }, []);

  useEffect(() => {
    if (keywords) {
      onSubmit(keywords);
    } else {
      setHighlightedIndex(-1);
      setResultList([]);
    }
  }, [keywords]);

  // 搜索联想
  const onSubmit = useCallback(
    debounce((e: string) => {
      setHighlightedIndex(-1);
      const params = {
        key: e,
        productCode: envCode as string,
        version: Version.V4,
        page: 1,
        size: 5,
      };
      getSearch(params).then((res) => {
        if (res.code === 200) {
          if (!e) {
            setResultList([]);
            return;
          }
          if (res.code === 200) {
            setResultList(res.data);
            setSearchStatus(true);
            const buryParams = {
              keyword: e,
              source: "search",
              answer: res.data?.slice(0, 5)?.map((item) => item.title) ?? [],
            };
            sendBuryById("4145e136-883e-4b77-93be-7f0c24900ee4", buryParams);
          } else {
            setResultList([]);
          }
        }
      });
    }, 400),
    [envCode] // 依赖项
  );

  // 键盘事件
  const handleKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      // 向下键
      setHighlightedIndex((prev) => (prev + 1) % resultList.length);
    } else if (e.key === "ArrowUp") {
      // 向上键
      setHighlightedIndex(
        (prev) => (prev - 1 + resultList.length) % resultList.length
      );
    } else if (e.key === "Enter") {
      // 回车键
      if (highlightedIndex >= 0 && highlightedIndex < resultList.length) {
        const selectedData = resultList[highlightedIndex];
        onSelected(selectedData, highlightedIndex);
      } else {
        getAnswers(e.target.value);
      }
    }
  };

  const onCompositionStart = () => {
    setIsComposing(true); // 输入法激活
  };

  const onCompositionEnd = (e: any) => {
    setIsComposing(false); // 输入法输入完成
    onSubmit(e.target.value); // 输入完成后触发搜索
  };

  const onChange = (e: any) => {
    const val = e.target?.value || "";
    setSearchValue(val);

    // 只有在输入法未激活时才触发防抖搜索
    if (!isComposing) {
      onSubmit(val);
    }
  };

  return (
    <div className="mb-[16px] font-pingfang-sc">
      <div className="relative max-w-[800px]">
        <Input
          className="font-medium text-base font-pingfang-sc h-[44px] custom-input"
          onChange={onChange}
          onKeyDown={handleKeyDown}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          placeholder={getLang("please_enter_keywords")}
          maxLength={500}
          value={searchValue}
          prefix={<SearchIcon className="w-[16px] h-[16px] mr-[4px]" />}
          suffix={
            searchValue && (
              <div className="opacity-60 text-[#1f2633] text-[13px] font-normal font-['PingFang SC'] border-l-[1px] border-[#e5e6eb] ml-[10px] flex items-center justify-center">
                <span
                  className="ml-[10px] px-[4px] cursor-pointer leading-[24px] rounded-[4px] hover:bg-[#f4f6f9] transition duration-300"
                  onClick={() => {
                    setSearchValue("");
                    onSubmit("");
                  }}
                  data-bury-id="385aee5f-f89b-453d-993b-f2ae339c0559"
                >
                  {getLang("cancel")}
                </span>
              </div>
            )
          }
        />
        {resultList.length && searchStatus ? (
          <div className="absolute top-[50px] left-[0px] z-10 w-full max-h-[471px] overflow-hidden overflow-y-auto bg-white rounded-[8px] custom-shadow p-[6px] search-results z-20">
            {resultList.map((item, index) => {
              return (
                <div
                  className="h-[32px] px-[14px] overflow-hidden text-[#1d2129] text-[13px] font-normal font-['PingFang SC'] cursor-pointer transition-colors duration-300 hover:bg-[#f4f6f9] rounded-[4px] flex items-center mb-[4px]"
                  key={JSON.stringify(item)}
                  onClick={() => onSelected(item, index)}
                  style={{
                    backgroundColor:
                      highlightedIndex === index ? "#f4f6f9" : "",
                  }}
                >
                  <span
                    className="m-0 overflow-hidden text-[#1d2129] text-[13px] font-normal font-['PingFang SC'] whitespace-nowrap truncate not-italic"
                    dangerouslySetInnerHTML={{
                      __html: item.title,
                    }}
                  ></span>
                  {item.source === "yd_doc" && (
                    <span className="text-xs whitespace-nowrap bg-[#f4f9ff] rounded-[5px] border border-[#dfebf7] justify-center items-center text-[#3499ff] px-[6px] ml-[6px]">
                      {getLang("official")}
                    </span>
                  )}
                  {item.isAccept && (
                    <span className="text-xs whitespace-nowrap bg-white rounded-[5px] border border-[#e8edf2] justify-center items-center text-[#9ea6b8] px-[6px] ml-[6px]">
                      {getLang("resolved")}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
};
