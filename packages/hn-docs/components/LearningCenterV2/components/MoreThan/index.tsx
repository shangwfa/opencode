"use client";

import React, { useEffect, useState } from "react";
import { Badge } from "antd";

import {
  init as initBridge,
  getUnreadMessageCount,
} from "@/utils/native-bridge";

import CommunityIcon from "/static/img/community.svg";
import FeedbackIcon from "/static/img/feedback.svg";
import WebsiteIcon from "/static/img/website.svg";

import "./index.css";
import { getLang } from "@/utils/getLang";

const moreSupports = [
  {
    title: getLang("ask_questions_in_the_community"),
    url: "community",
    icon: <CommunityIcon />,
  },
  {
    title: getLang("contact_us"),
    url: "feedback",
    icon: <FeedbackIcon />,
  },
  {
    title: getLang("official_website"),
    url: getLang("official_website_url"),
    icon: <WebsiteIcon />,
  },
];

export default () => {
  const [unreadTotal, setUnreadTotal] = useState<number>(0);

  useEffect(() => {
    getUnreadMessageCountFn();
  }, []);

  const getUnreadMessageCountFn = () => {
    initBridge().then(() =>
      getUnreadMessageCount().then((res) => setUnreadTotal(res))
    );
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
    <div className="mt-[14px] font-pingfang-sc bg-white pt-[14px] pb-[16px] rounded-[8px]">
      <div className="text-[14px] text-[#1f2633] font-semibold font-['PingFang SC'] px-[16px]">
        没有找到想要的？
      </div>
      <div className="flex justify-between items-center mt-[16px] px-[8px]">
        {moreSupports.map((item, index) => (
          <div
            key={index}
            className="flex justify-between items-center cursor-pointer hover:bg-[#f4f6f9] rounded-[4px] px-[8px] transition-colors duration-300"
            onClick={() => {
              if (item.url === "feedback") {
                contactUs();
              } else if (item.url === "community") {
                gotoCommunity();
              } else {
                window.open(item.url);
              }
            }}
            data-bury-id="f581b892-5a49-4da5-8add-e6557da2a00e"
          >
            {item.icon}
            <span className="text-[#1F2633] text-[13px] pl-[10px]">
              {item.title}
              {item.url === "feedback" && unreadTotal > 0 && (
                <Badge count={unreadTotal} size="small" className="ml-[4px]" />
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
