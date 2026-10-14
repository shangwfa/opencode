import React, { useEffect, useState } from "react";
import { Input } from "antd";
import { useRouter } from "next/router";

import { getUrlParams } from "@/utils";
import { getLang } from "@/utils/getLang";

import SearchIcon from "/static/img/search.svg";
import LeftIcon from "/static/img/left.svg";

import "./index.css";

interface Iprops {
  keywords: string;
  onKeyChange: (key: string) => void;
}

export default (props: Iprops) => {
  const { keywords, onKeyChange } = props;
  const [searchValue, setSearchValue] = useState("");

  const router = useRouter();
  const searchData = router.query.keywords;
  const menuId = router.query.menuId as string | undefined;

  useEffect(() => {
    if (searchData !== searchValue && !menuId) {
      setSearchValue(searchData as string);
    }
  }, [searchData]);

  const getAnswers = (key: string) => {
    setSearchValue(key);
    if (key) {
      const asPathWithoutQuery = router.asPath.split("?")[0];
      router.push(
        `${asPathWithoutQuery}?keywords=${key}` // 新URL
      );

      const node = document.querySelector("#scroll-container");
      if (node) {
        node.scrollTop = 0;
      }
    }
  };

  useEffect(() => {
    if (keywords) {
      setSearchValue(keywords);
    }
  }, [keywords]);

  // 返回首页
  const onGoHome = () => {
    const searchData = getUrlParams("keywords");
    if (menuId) {
      const asPathWithoutQuery = router.asPath.split("?")[0];
      router.push(
        `${asPathWithoutQuery}?keywords=${searchData}`, // 新URL
        undefined, // 可选的pathname（此处不需要）
        { shallow: true } // 启用浅路由
      );
    } else if (keywords) {
      onCanCel();
    } else if (window.location.pathname.includes("/help")) {
      router.push(`/rpa?keywords=${searchData}&referrer=rpa-win`);
    } else {
      router.push(`/rpa/help?keywords=${searchData}`);
    }
  };

  const onCanCel = () => {
    const url = window.location.pathname;
    window.location.href = `${url.includes("/rpa/") ? url : url + "?referrer=rpa-win"}`;
  };

  return (
    <div className="px-[16px] pt-[20px] fixed z-[100] w-full">
      <div className="flex items-center h-[48px] leading-[48px]">
        <Input
          className="font-medium text-base font-pingfang-sc h-[44px] custom-search-portal-input"
          onPressEnter={(e: any) => getAnswers(e?.target?.value)}
          onChange={(e) => {
            if (!e.target.value) {
              getAnswers(e.target.value);
            } else {
              setSearchValue(e.target.value);
            }
          }}
          placeholder={getLang("please_enter_keywords")}
          maxLength={500}
          value={searchValue}
          prefix={
            <div className="flex items-center">
              <div
                onClick={() => onGoHome()}
                className="w-[32px] h-[32px] mr-[4px] rounded-[4px] cursor-pointer hover:bg-[#f4f6f9] flex items-center justify-center transition duration-300"
              >
                <LeftIcon
                  className="w-[12px] h-[12px]"
                  data-bury-id="1bd80536-6e28-4348-a5d7-e0c33c3839b3"
                />
              </div>
              <div className="w-[1px] bg-[#e5e6eb] mr-[14px] h-[16px]"></div>
              <SearchIcon className="w-[16px] h-[16px]" />
            </div>
          }
          suffix={
            (searchValue || keywords) && (
              <div className="opacity-60 text-[#1f2633] text-[13px] font-normal font-['PingFang SC'] border-l-[1px] border-[#e5e6eb] ml-[10px] flex items-center justify-center">
                <span
                  className="ml-[10px] px-[4px] cursor-pointer leading-[24px] rounded-[4px] hover:bg-[#f4f6f9] transition duration-300"
                  onClick={() => onCanCel()}
                  data-bury-id="6aeaa354-021d-4e53-a4f4-73db2c30e47f"
                >
                  {getLang("cancel")}
                </span>
              </div>
            )
          }
        />
      </div>
    </div>
  );
};
