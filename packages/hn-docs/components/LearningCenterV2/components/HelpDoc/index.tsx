"use client";

import React from "react";
import { useRouter } from "next/router";

import { getLang } from "@/utils/getLang";

import FlagIcon from "/static/img/flag.svg";
import RocketIcon from "/static/img/rocket.svg";
import LayersThreeIcon from "/static/img/layers_three.svg";
import MessageQuestionCircle from "/static/img/message_question_circle.svg";
import RightIcon from "/static/img/right.svg";

const docList = [
  {
    title: getLang("introduction"),
    url: "711649427620073472",
    icon: <RocketIcon className="w-[16px] h-[16px]" />,
  },
  {
    title: getLang("interface"),
    url: "711626382286766080",
    icon: <FlagIcon className="w-[16px] h-[16px]" />,
  },
  {
    title: getLang("commands"),
    url: "711200729240932352",
    icon: <LayersThreeIcon className="w-[16px] h-[16px]" />,
  },
  {
    title: getLang("FAQ"),
    url: "710526109107601408",
    icon: <MessageQuestionCircle className="w-[16px] h-[16px]" />,
  },
];

export default () => {
  const router = useRouter();
  const { brandCode } = router.query;

  // 帮助中心
  const goToHelpCenter = () => {
    router.push(`/${brandCode}/help`);
  };

  const jumpToDoc = (url: string) => {
    // 有自定义路径
    router.push(`/${brandCode}/help?id=${url}`);
  };

  return (
    <>
      {/* 获得支持 */}
      <div className="my-[14px] font-pingfang-sc bg-white pb-[2px] rounded-[8px]">
        <div className="pt-[14px] pb-[12px] font-pingfang flex items-center justify-between pl-[16px] pr-[10px]">
          <div className="text-[14px] text-[#1f2633] font-semibold font-['PingFang SC']">
            {getLang("help_documents")}
          </div>
          <span
            className="text-[#1F2633] text-[13px] opacity-60  cursor-pointer px-[6px] hover:bg-[#f4f6f9] rounded-[4px] transition duration-300"
            onClick={goToHelpCenter}
            data-bury-id="7dec65bf-eade-41e0-8959-40d35e0dcdc4"
          >
            {getLang("more")}
          </span>
        </div>
        <div className="px-[8px]">
          {docList.map((item) => (
            <div
              key={item.url}
              className="flex items-center cursor-pointer mb-[6px] hover:bg-[#f4f6f9] rounded-[4px] leading-[32px] px-[8px] transition-colors duration-300"
              onClick={() => jumpToDoc(item.url)}
              data-bury-id="557b8dfa-5dcc-467d-91d0-6db543b486f8"
            >
              {item.icon}
              <div className="flex-1 ml-[10px] text-[#1f2633] font-normal text-[13px]">
                {item.title}
              </div>
              <RightIcon className="ml-[4px]" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
};
