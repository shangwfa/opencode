import React from "react";

import { useIsYdBrowser } from "@/hooks";
import { recordLog, ShowPublishErrorWindow } from "@/utils";
import { getLang } from "@/utils/getLang";
import { env } from "@/utils/env";

import EmptyIcon from "/static/img/empty.svg";
import RightBlackIcon from "/static/img/right-black.svg";

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
  isEmptyImg?: boolean;
}

export const Empty: React.FC<IProps> = (p) => {
  const { keywords, isEmptyImg = true } = p;
  const isYd = useIsYdBrowser();

  return (
    <div className="w-[270px] mx-auto mt-[20px] py-[40px]">
      {isEmptyImg && (
        <EmptyIcon className="block mx-auto mt-[72px] mb-[25px] ml-[70px]" />
      )}
      <p className="m-0 mb-[10px] text-[#1f2633] text-base font-semibold font-['PingFang SC'] leading-[25px] text-center">
        没有找到想要的内容？
      </p>
      {isYd && env.ENV !== "international" ? (
        <>
          <span className="block text-[#1f2633] text-[13px] font-normal font-['PingFang SC'] leading-none text-center">
            {getLang("ask_questions_in_the_community_and_technical")}
          </span>
          <div
            onClick={() => {
              ShowPublishErrorWindow(keywords);
              recordLog(keywords, "noResult");
            }}
            className="flex items-center justify-center w-[90px] h-[32px] mx-auto mt-[24px] text-white leading-[32px] bg-[#232a37] rounded-lg cursor-pointer text-[12px] pl-[5px] hover:opacity-80 transition duration-300"
            data-bury-id="a7bde824-6343-41bd-bf97-39702f10804d"
          >
            {getLang("quick_questions")}
            <RightBlackIcon className="ml-[2px]" />
          </div>
        </>
      ) : (
        <span className="block text-gray-400 font-normal text-sm leading-none text-center pl-[7px]">
          {getLang("please_try_another_search_term")}
        </span>
      )}
    </div>
  );
};

export default Empty;
