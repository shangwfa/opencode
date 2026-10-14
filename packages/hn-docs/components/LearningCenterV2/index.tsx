"use client";

import { Skeleton } from "antd";
import React, { useEffect, useRef, useState } from "react";

import { getNewClientLearnStatus } from "@/api/college";
import { getListBySceneCode } from "@/api/public";
import { type LearnProgressInfoData } from "@/components/LearningCenterV2/index.d";
import { env } from "@/utils/env";

import { useIsYdBrowser } from "@/hooks";
import { getUrlParams } from "@/utils";
import { init as initBridge, isHybridCloud } from "@/utils/native-bridge";
import AutoCompleteSearch from "./components/AutoCompleteSearch";
import College from "./components/College";
import HelpDoc from "./components/HelpDoc";
import MobileSearch from "./components/MobileSearch";
import MoreThan from "./components/MoreThan";
import MoreThanV2 from "./components/MoreThanV2";
import Tutorial from "./components/Tutorial";
import WorkOrder from "./components/WorkOrder";
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

export const LearningCenterV2: React.FC<{}> = (p) => {
  const [keywords, setKeywords] = useState("");
  const [videoTutorial, setVideoTutorial] = useState<ContentInfo[]>([]);
  const [videoTutorialMore, setVideoTutorialMore] = useState("");
  const [isHybrid, setIsHybrid] = useState(false);
  const isYD = useIsYdBrowser();
  const [isLoading, setIsLoading] = useState(false);
  const [isCollegeAuth, setIsCollegeAuth] = useState(false);
  const [learnData, setLearnData] = useState({} as LearnProgressInfoData);

  const isCollegeReqStatus = useRef(false);
  const isTutorialReqStatus = useRef(false);
  const uiDesign = getUrlParams("uiDesign");

  const getIsHybridCloudFn = () => {
    initBridge().then(() => isHybridCloud().then((res) => setIsHybrid(res)));
  };

  useEffect(() => {
    getIsHybridCloudFn();
    getPageConfig();
  }, []);

  useEffect(() => {
    if (isYD && (env.ENV != "private" || isHybrid)) {
      setIsCollegeAuth(true);
      isCollegeReqStatus.current = true;
      getNewClientLearnInfo();
    } else {
      setIsCollegeAuth(false);
      isCollegeReqStatus.current = false;
    }
  }, [isYD, isHybrid]);

  // banner
  const getPageConfig = () => {
    setIsLoading(true);
    isTutorialReqStatus.current = true;
    const params = {
      sceneCodes: "LearningCenterV2",
    };
    getListBySceneCode(params)
      .then((res) => {
        if (res.code === 200) {
          const { LearningCenterV2 = {} } = res?.data || {};
          console.log(LearningCenterV2, "LearningCenter");
          const contentInfos =
            LearningCenterV2?.dataSources?.[0]?.contents?.[0]?.contentInfos ||
            [];
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
          setVideoTutorial(videoTutorialList);
        }
      })
      .finally(() => {
        isTutorialReqStatus.current = false;
        if (!isCollegeReqStatus.current) {
          setIsLoading(false);
        }
      });
  };

  const getNewClientLearnInfo = () => {
    getNewClientLearnStatus()
      .then((res) => {
        if (res.code === 200) {
          setLearnData(res.data);
        } else {
          setIsCollegeAuth(false);
        }
      })
      .finally(() => {
        isCollegeReqStatus.current = false;
        if (!isTutorialReqStatus.current) {
          setIsLoading(false);
        }
      });
  };

  return !keywords ? (
    <>
      {isLoading ? (
        <div className="px-[16px] pt-[30px]">
          <Skeleton active paragraph={{ rows: 20 }} />
        </div>
      ) : (
        <div
          className="scrollbar-custom select-none"
          style={{ height: "100vh" }}
        >
          <div
            className="w-full z-10 pt-[20px] px-[16px] pb-[16px] text-gray-800 text-base"
            style={{
              marginTop: isYD ? 0 : "61px",
            }}
          >
            <AutoCompleteSearch onSetKeywords={(value) => setKeywords(value)} />
            {/* 学院学习引导 */}
            {isCollegeAuth && (
              <College isHybrid={isHybrid} learnProgressInfoData={learnData} />
            )}
            {/* 视频教程 */}
            {videoTutorial.length > 0 &&
            (env.ENV != "private" || isHybrid) ? (
              <Tutorial
                videoTutorial={videoTutorial}
                videoTutorialMore={videoTutorialMore}
                isHybrid={isHybrid}
              />
            ) : null}
            {/* 帮助文档 */}
            <HelpDoc />
              {/* 寻求技术帮助 (6.0版本 国内版存在)*/}
              {/* 获得支持  更多资源*/}
            {!!(uiDesign && process.env.NEXT_PUBLIC_ENV !== "private" && process.env.NEXT_PUBLIC_ENV !== "international") ? (
              <>
                <WorkOrder />
                <MoreThanV2 />
              </>
            ) : (
              <MoreThan />
            )}
          </div>
        </div>
      )}
    </>
  ) : (
    <MobileSearch onKeyChange={(e) => setKeywords(e)} keywords={keywords} />
  );
};
export default LearningCenterV2;
