import React from "react";
import { useRouter } from "next/router";
import { sendBuryById } from "@xybot/bury";

import { recordLog } from "@/utils";
import { getLang } from "@/utils/getLang";

interface IProps {
  list?: {
    url: string;
    source: string;
    sourceName: string;
    title: string;
    body: string;
    tag: string;
    score: number;
  }[];
  keywords: string;
}

export const SearchItem: React.FC<IProps> = (p) => {
  const { list = [], keywords } = p;

  const router = useRouter();
  const { from } = router.query;

  const clickItem = (item: any, index: number) => {
    const params = {
      keyword: keywords,
      source: "search-click",
      tab: item.source,
      openTarget: item.title,
      index,
      answer: list?.slice(0, 5)?.map((item) => item.title) ?? [],
    };
    sendBuryById("39c73c54-45a3-4b47-85b6-73f08d0aa9d4", params);

    recordLog(keywords);

    const url =
      item.source == "forum"
        ? decodeURIComponent(item.url)
        : decodeURIComponent(item.url) +
          `?source=${keywords}${from ? `&from=${from}` : ""}`;
    item.source === "forum" ? "" : url;

    if (item.source === "forum") {
      window.open(url, "_blank");
    } else {
      const asPathWithoutQuery = router.asPath.split("?")[0];
      router.push(
        `${asPathWithoutQuery}?menuId=${item.id}&keywords=${keywords}`, // 新URL
        undefined, // 可选的pathname（此处不需要）
        { shallow: true } // 启用浅路由
      );
    }
  };

  return (
    <>
      {list?.map((e: any, index: number) => (
        <div
          key={index}
          className="py-[12px] rounded-md cursor-pointer"
          onClick={() => clickItem(e, index)}
        >
          <div className="flex items-center">
            <h3
              className="m-0 overflow-hidden text-[#1d2129] text-[sm] font-semibold leading-normal search-content-v2 whitespace-nowrap truncate"
              dangerouslySetInnerHTML={{
                __html: e.title,
              }}
            ></h3>
            {e.source === "yd_doc" && (
              <span className="text-xs whitespace-nowrap bg-[#f4f9ff] rounded-[5px] border border-[#dfebf7] justify-center items-center text-[#3499ff] px-[6px] ml-[6px]">
                {getLang("official")}
              </span>
            )}
            {e.isAccept && (
              <span className="text-xs whitespace-nowrap bg-white rounded-[5px] border border-[#e8edf2] justify-center items-center text-[#9ea6b8] px-[6px] ml-[6px]">
                {getLang("resolved")}
              </span>
            )}
            {e.answerCount ? (
              <span className="whitespace-nowrap text-[13px] font-normal ml-[6px]">
                {e.answerCount}
                {getLang("comment")}
              </span>
            ) : null}
          </div>
          {!!e.body && (
            <div
              className="clamp-3"
              dangerouslySetInnerHTML={{
                __html: e.body,
              }}
            ></div>
          )}
        </div>
      ))}
    </>
  );
};

export default SearchItem;
