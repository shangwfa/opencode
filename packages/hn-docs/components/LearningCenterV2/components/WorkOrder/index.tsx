"use client";

import { createJumpToken } from "@/api/account";
import { useSharedData } from "@/context/SharedDataContext";
import { env } from "@/utils/env";
import { getLang } from "@/utils/getLang";
import {
  getUnreadMessageCount,
  init as initBridge,
} from "@/utils/native-bridge";
import { Badge } from "antd";
import { useEffect, useState } from "react";
import ClipboardIcon from "/static/img/clipboard.svg";
import CommunityIcon from "/static/img/community.svg";
import HeadPhoneIcon from "/static/img/head_phones.svg";
import RightIcon from "/static/img/right.svg";
import UserMdIcon from "/static/img/user-md.svg";

const docList = [
  //在线咨询
  {
    title: getLang("online_consultation"),
    url: "feedback",
    icon: <HeadPhoneIcon className="w-[16px] h-[16px]" />,
  },
  // 提交工单
  {
    title: getLang("submit_work_order"),
    url: "submit_work_order",
    icon: <ClipboardIcon className="w-[16px] h-[16px]" />,
  },
  // 我的工单
  {
    title: getLang("my_work_order"),
    url: "my_work_order",
    icon: <UserMdIcon className="w-[16px] h-[16px]" />,
  },
];

const COMMUNITY_INFO = {
  title: getLang("ask_questions_in_the_community"),
  url: "community",
  icon: <CommunityIcon className="w-[16px] h-[16px]" />,
};

export default () => {
  const [unreadTotal, setUnreadTotal] = useState<number>(0);
  const [helpList, setHelpList] = useState<any[]>([]);
  const { sharedData } = useSharedData();
  const [woUnreadTotal, setWOUnreadTotal] = useState<number>(0);

  useEffect(() => {
    getUnreadMessageCountFn();
    getWOUnreadMessageCount();
  }, []);

  useEffect(() => {
    setHelpList([
      ...(sharedData.userGrade == "enterprise" ? docList : []),
      COMMUNITY_INFO,
    ]);
  }, [sharedData.userGrade]);

  const getUnreadMessageCountFn = () => {
    initBridge().then(() =>
      getUnreadMessageCount().then((res) => setUnreadTotal(res)),
    );
  };

  const getWOUnreadMessageCount = () => {
    initBridge().then(({ javascriptBinding }) => {
      if (javascriptBinding?.getUnreadTicketMessageCount) {
        javascriptBinding.getUnreadTicketMessageCount()?.then((res) => setWOUnreadTotal(res));
      }
    });
  };

  const gotoCommunity = () => {
    initBridge().then(({ javascriptBinding }) => {
      javascriptBinding?.goToCommunity?.();
    });
  };

  const contactUs = () => {
    initBridge().then(({ javascriptBinding }) => {
      javascriptBinding?.showFeedback?.();
    });
  };

  const onlineSupport = () => {
    initBridge().then(({ javascriptBinding }) => {
      if (javascriptBinding?.openOnlineSupport) {
        javascriptBinding?.openOnlineSupport?.();
      } else {
        javascriptBinding?.showFeedback?.();
      }
    });
  };

  const gotoMyWorkOrder = async () => {
    const res = await createJumpToken();
    if (res.code === 200) {
      await openWorkOrderHistoryLink(res.data);
    }
  };
  const gotoSubmitWorkOrder = async () => {
    const res = await createJumpToken();
    if (res.code === 200) {
      await openWorkOrderCreateLink(res.data);
    }
  };

  const openWorkOrderCreateLink = async (token) => {
    const homeUrl = env.HOME_URL;
    initBridge().then(({ javascriptBinding }) => {
      if (javascriptBinding?.getFileKey) {
        javascriptBinding
          ?.getFileKey?.()
          .then((res) => {
            const fileKey = encodeURIComponent(res);
            const url = `${homeUrl}/community/workOrder?token=${token}&fileKey=${fileKey}`;
            window.open(url, "_blank");
          })
          .catch((err) => {});
      } else {
        const url = `${homeUrl}/community/workOrder?token=${token}`;
        window.open(url, "_blank");
      }
    });
  };

  const openWorkOrderHistoryLink = async (token) => {
    const homeUrl = env.HOME_URL;
    const url = `${homeUrl}/devpilot/wo/list?token=${token}`;
    window.open(url, "_blank");
  };

  return (
    <>
      {/* 获得支持 */}
      <div className="my-[14px] font-pingfang-sc bg-white pb-[2px] rounded-[8px]">
        <div className="pt-[14px] pb-[12px] font-pingfang flex items-center justify-between pl-[16px] pr-[10px]">
          <div className="text-[14px] text-[#1f2633] font-semibold font-['PingFang SC']">
            {getLang("seek_technical_help")}
          </div>
        </div>
        <div className="px-[8px]">
          {helpList.map((item) => (
            <div
              key={item.url}
              className="flex items-center cursor-pointer mb-[6px] hover:bg-[#f4f6f9] rounded-[4px] leading-[32px] px-[8px] transition-colors duration-300"
              onClick={() => {
                if (item.url === "feedback") {
                  onlineSupport();
                } else if (item.url === "community") {
                  gotoCommunity();
                } else if (item.url === "my_work_order") {
                  gotoMyWorkOrder();
                } else if (item.url === "submit_work_order") {
                  gotoSubmitWorkOrder();
                }
              }}
              data-bury-id="557b8dfa-5dcc-467d-91d0-6db543b486f8"
            >
              {item.icon}
              <div className="flex-1 ml-[10px] text-[#1f2633] font-normal text-[13px]">
                {item.title}
                {item.url === "feedback" && unreadTotal > 0 && (
                  <Badge
                    count={unreadTotal}
                    size="small"
                    className="ml-[4px]"
                  />
                )}
                {item.url === "my_work_order" && woUnreadTotal > 0 && (
                  <Badge count={woUnreadTotal} size="small" className="ml-[4px]" />
                )}
              </div>
              <RightIcon className="ml-[4px]" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
};
