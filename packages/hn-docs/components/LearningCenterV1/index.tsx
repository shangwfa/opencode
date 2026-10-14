"use client";

import React, { useEffect, useState } from "react";
import { Input } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { useRouter } from "next/router";
import { sendBuryById } from "@xybot/bury";

import { getUrlParams, replaceUrlParams, recordLog, debounce } from "@/utils";
import { useIsYdBrowser } from "@/hooks";
import { init as initBridge, isHybridCloud } from "@/utils/native-bridge";
import { getLang } from "@/utils/getLang";
import { env } from "@/utils/env";

import Search from "./components/Search";
import College from "./components/College";
import VideoTutorials from "./components/VideoTutorials";
import MoreSupport from "./components/MoreSupport";

import { helpDocTips, getListBySceneCode } from "@/api/public";
import { Version } from "@/api/index.d";

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

export const LearningCenterV1: React.FC<{}> = (p) => {
  const [keywords, setKeywords] = useState("");
  const [submit, setSubmit] = useState([]);
  const [videoTutorial, setVideoTutorial] = useState<ContentInfo[]>([]);
  const [videoTutorialMore, setVideoTutorialMore] = useState("");
  const [resources, setResources] = useState<ContentInfo[]>([]);
  const [isHybrid, setIsHybrid] = useState(false);

  const isYD = useIsYdBrowser();

  const router = useRouter();
  const { brandCode } = router.query;

  useEffect(() => {
    getIsHybridCloudFn();
  }, []);

  const getIsHybridCloudFn = () => {
    initBridge().then(() => isHybridCloud().then((res) => setIsHybrid(res)));
  };

  const getAnswers = (e: string) => {
    setKeywords(e);
    recordLog(e);
    replaceUrlParams("keywords", e);
  };

  useEffect(() => {
    setKeywords(getUrlParams("keywords"));
  }, []);
  useEffect(() => {
    onSubmit(keywords);
  }, [keywords]);

  useEffect(() => {
    getPageConfig();
  }, []);

  // 搜索联想
  const onSubmit = debounce((e: string) => {
    const params = {
      key: e,
      productCode: brandCode as string,
      version: Version.V4,
    };
    helpDocTips(params).then((res) => {
      if (res.code === 200) {
        setSubmit(res.data || []);
        const buryParams = {
          keyword: e,
          source: "search",
          answer: res.data?.slice(0, 5) ?? [],
          tab: "",
        };
        sendBuryById("0c3daf14-8609-47de-8fa3-57a5eca979b2", buryParams);
      }
    });
  }, 200);

  // banner
  const getPageConfig = () => {
    const params = {
      sceneCodes: "LearningCenter",
    };
    getListBySceneCode(params).then((res) => {
      if (res.code === 200) {
        const { LearningCenter = {} } = res?.data || {};
        const contentInfos =
          LearningCenter?.dataSources?.[0]?.contents?.[0]?.contentInfos || [];
        const videoTutorialList: ContentInfo[] = [];
        const resources: ContentInfo[] = [];
        contentInfos.forEach((contentInfo: ContentInfo) => {
          switch (contentInfo.contentTag) {
            case "VideoTutorial":
              videoTutorialList.push(contentInfo);
              break;
            case "VideoTutorialMore":
              setVideoTutorialMore(contentInfo.contentJumpUrl);
              break;
            case "Resources":
              resources.push(contentInfo);
              break;
          }
        });
        setResources(resources);
        setVideoTutorial(videoTutorialList);
      }
    });
  };

  const onSelected = (item: string, index: number) => {
    const buryParams = {
      keyword: keywords,
      source: "search-click",
      tab: "",
      openTarget: item,
      index,
      answer: submit?.slice(0, 5) ?? [],
    };
    sendBuryById("1f7b340f-e069-42b1-b066-ecf81466f8b2", buryParams);
    getAnswers(item);
  };

  return !keywords ? (
    <div
      className="w-full  z-10 p-[24px] px-[20px] text-gray-800 text-base bg-white"
      style={{ marginTop: isYD ? 0 : "61px" }}
    >
      <div className="mb-[24px] font-pingfang-sc">
        <div className="relative max-w-[800px]">
          <Input
            className="mb-[16px] font-medium text-base font-pingfang-sc leading-6 custom-input-v1"
            onPressEnter={(e: any) => getAnswers(e?.target?.value)}
            onChange={(e) => onSubmit(e.target.value)}
            placeholder={getLang("what_can_we_help_you_find")}
            maxLength={500}
            allowClear
            prefix={
              <SearchOutlined
                style={{ color: "#ABB1BD", marginRight: "4px" }}
              />
            }
          />
          <div className="absolute top-[50px] left-[0px] z-10 w-full max-h-[471px] overflow-hidden overflow-y-auto bg-white rounded-[3px] custom-shadow">
            <ul className="m-0 p-0 list-none">
              {submit.map((item, index) => {
                return (
                  <li
                    key={index}
                    onClick={() => onSelected(item, index)}
                    className="max-h-[40px] px-[14px] overflow-hidden leading-[40px] whitespace-nowrap overflow-ellipsis cursor-pointer transition-colors duration-300 hover:bg-gray-300"
                  >
                    {item}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>
      {/* 学院学习引导 */}
      {isYD && <College isHybrid={isHybrid} />}
      {/* 视频教程 */}
      {videoTutorial.length > 0 &&
      (env.ENV != "private" || isHybrid) ? (
        <VideoTutorials
          videoTutorial={videoTutorial}
          videoTutorialMore={videoTutorialMore}
          isHybrid={isHybrid}
        />
      ) : null}
      {/* 获得支持  更多资源*/}
      <MoreSupport resources={resources} isHybrid={isHybrid} />
    </div>
  ) : (
    <Search onKeyChange={(e) => setKeywords(e)} keywords={keywords} />
  );
};
export default LearningCenterV1;
