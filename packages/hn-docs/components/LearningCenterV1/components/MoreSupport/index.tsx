"use client";

import React, { useEffect, useState } from "react";
import { Badge } from "antd";
import { RightOutlined, ArrowUpOutlined } from "@ant-design/icons";
import Image from "next/image";

import {
  init as initBridge,
  getUnreadMessageCount,
} from "@/utils/native-bridge";
import { useJumpUrl } from "@/hooks/jump-url";
import { getLang } from "@/utils/getLang";
import { env } from "@/utils/env";

import BookIcon from "/static/img/bookIcon.svg";
import ServiceIcon from "/static/img/serviceIcon.svg";
import UserIcon from "/static/img/userIcon.svg";
import support from "/static/img/support.png";

import "./index.css";

interface ContentInfo {
  contentDate: string;
  contentJumpUrl: string;
  contentLogoUrl: string;
  contentTag: string;
  contentTime: string;
  contentTitle: string;
  contentUrl: string;
  contentUuid: string;
}

interface Props {
  resources: ContentInfo[];
  isHybrid: boolean;
}

export default (props: Props) => {
  const { resources, isHybrid } = props;
  const jumpUrl = useJumpUrl();

  const [unreadTotal, setUnreadTotal] = useState<number>(0);
  const isInternational = env.ENV == "international";

  useEffect(() => {
    getUnreadMessageCountFn();
  }, []);

  const getUnreadMessageCountFn = () => {
    initBridge().then(() =>
      getUnreadMessageCount().then((res) => setUnreadTotal(res))
    );
  };

  // 帮助中心
  const goToHelpCenter = () => {
    window.location.href = jumpUrl("help");
  };

  // 联系影刀
  const contactUs = () => {
    initBridge().then(({ javascriptBinding }) => {
      javascriptBinding?.showFeedback?.();
    });
  };

  // 去社区提问
  const gotoCommunity = () => {
    initBridge().then(({ javascriptBinding }) => {
      javascriptBinding?.goToCommunity?.();
    });
  };

  return (
    <>
      {/* 获得支持 */}
      <div className="my-[24px] font-pingfang-sc">
        <div className="mb-[16px] font-medium text-[16px] font-pingfang leading-[22px]">
          {getLang("get_support")}
        </div>
        <div
          className="flex items-center p-[8px] rounded-md cursor-pointer hover:bg-gray-100 support-item"
          onClick={goToHelpCenter}
          data-bury-id="d110d7fa-0dae-42bc-ae09-998ec53e582a"
        >
          <BookIcon className="w-[22px] h-[22px]" />
          <div className="flex-1 ml-[8px] text-gray-700 font-normal text-[14px]">
            {getLang("help_documents")}
          </div>
          <RightOutlined color="#7A889E" className="ml-[4px]" />
        </div>
        {!isInternational && (
          <div
            className="flex items-center p-[8px] rounded-md cursor-pointer hover:bg-gray-100 support-item"
            onClick={gotoCommunity}
            data-bury-id="be05086c-8eca-4a3c-97e8-bde937ec0e94"
          >
            <UserIcon className="w-[22px] h-[22px]" />
            <div className="flex-1 ml-[8px] text-gray-700 font-normal text-[14px]">
              {getLang("ask_questions_in_the_community")}
            </div>
            <ArrowUpOutlined className="transform rotate-45" color="#7A889E" />
          </div>
        )}
        <div
          className="flex items-center p-[8px] rounded-md cursor-pointer hover:bg-gray-100 support-item"
          onClick={contactUs}
          data-bury-id="81a74d96-e67a-4aff-9976-92d63f9f91f5"
        >
          <ServiceIcon className="w-[22px] h-[22px]" />
          <div className="flex-1 ml-[8px] text-gray-700 font-normal text-[14px]">
            {getLang("contact_us")}
            <Badge count={unreadTotal} size="small" className="ml-[4px]" />
          </div>
          <ArrowUpOutlined className="transform rotate-45" color="#7A889E" />
        </div>
      </div>
      {/* 更多资源 */}
      {resources.length > 0 && !isInternational && (
        <div className="my-[24px] font-pingfang-sc">
          <div className="mb-[16px] font-medium text-[16px] font-pingfang leading-[22px]">
            {getLang("more")}
          </div>
          {resources.map((res, index) => (
            <div
              key={index}
              className="flex items-center p-[8px] rounded-md cursor-pointer hover:bg-gray-100 support-item"
              onClick={() => window.open(res.contentJumpUrl, "_blank")}
              data-bury-id="1552998e-b159-435a-be00-342388298063"
            >
              {isHybrid ? (
                <Image src={support} width={22} height={22} alt="RPA" />
              ) : (
                <img
                  src={res.contentLogoUrl}
                  alt=""
                  className="w-[22px] h-[22px]"
                />
              )}

              <div className="flex-1 ml-[8px] text-gray-700 font-normal text-[14px]">
                {res.contentTitle}
              </div>
              <ArrowUpOutlined
                className="transform rotate-45 ml-[4px]"
                color="#7A889E"
              />
            </div>
          ))}
        </div>
      )}
    </>
  );
};
