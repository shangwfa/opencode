"use client";

import React from "react";
import { Tooltip } from "antd";
import Image from "next/image";

import { createJumpToken, proxyToken } from "@/api/account";
import { getLang } from "@/utils/getLang";
import { env } from "@/utils/env";

import {
  type LearnProgressInfoData,
  LearnStatus,
} from "@/components/LearningCenterV2/index.d";

import FireIcon from "/static/img/fire.svg";
import BadgeIcon from "/static/img/badge.svg";
import RightBlackIcon from "/static/img/right-black.svg";
import studying from "/static/img/studying.png";
import completeAll from "/static/img/completeAll.png";
import afterStudying from "/static/img/afterStudying.png";
import Bg1Icon from "/static/img/bg-1.svg";
import Bg2Icon from "/static/img/bg-2.svg";

enum Target {
  lesson = "lesson",
  course = "course",
}

interface Props {
  isHybrid: boolean;
  learnProgressInfoData: LearnProgressInfoData;
}

export default (props: Props) => {
  const { isHybrid, learnProgressInfoData } = props;

  const openLessonLink = (token: string, target: Target | null) => {
    let url = env.COLLEGE_BASE_URL;
    // 未开始学习调转到学院首页;
    if (learnProgressInfoData.learnRouteStatus === LearnStatus.notStart) {
      url = `${url}?token=${token}`;
    } else if (target === Target.lesson) {
      url = `${url}/lesson?token=${token}`;
    } else if (target === Target.course) {
      url = `${url}/course?token=${token}&classInfoUuid=${learnProgressInfoData.classInfoUuid}`;
    }

    window.open(url, "_blank");
  };

  const btnClick = async (target: Target | null) => {
    if (isHybrid) {
      const res = await proxyToken();
      if (res.code === 200) {
        await openLessonLink(res.data, target);
      }
      return;
    }

    if (env.ENV !== "private") {
      const res = await createJumpToken();
      if (res.code === 200) {
        await openLessonLink(res.data.accessToken || res.data, target);
      }
    }
  };

  return (
    <div className="my-[14px] font-pingfang-sc bg-white pb-[12px] rounded-[8px]">
      <div className="py-[14px] flex justify-between items-center pl-[16px] pr-[10px]">
        <div className="flex items-center">
          <div className="text-[#1f2633] text-[14px] font-semibold font-['PingFang SC'] mr-[10px]">
            {getLang("Learning")}
          </div>
          <div className="flex items-center text-[#FF5C00] text-[12px] bg-[#f7f8fd] rounded-lg pl-[4px] pr-[6px]">
            <FireIcon className="mr-[2px]" />
            {learnProgressInfoData.learnRouteStatus === LearnStatus.notStart &&
            learnProgressInfoData.isEnterprise
              ? `${getLang("the_company_has_paid_for_you")}${learnProgressInfoData.paidFund || 0} ${getLang("meta_learning_fund")}`
              : `${learnProgressInfoData.getCertNum || 0} ${getLang("the_person_has_obtained_the_certificate")}`}
          </div>
        </div>
        <div
          className="text-[#1F2633] text-[13px] opacity-60 cursor-pointer px-[6px] hover:bg-[#f4f6f9] rounded-[4px] transition duration-300"
          onClick={() => btnClick(Target.lesson)}
          data-bury-id="8e0585f4-9e28-4095-8639-623a8d4892c8"
        >
          {getLang("more")}
        </div>
      </div>
      <div className="flex justify-between px-[16px]">
        <div className="flex justify-between flex-1 min-w-0 relative">
          <div className="rounded-md overflow-hidden mr-[18px] w-[90px] flex-shrink-0 ">
            <Image
              src={
                Number(learnProgressInfoData.bookLevel) === 1
                  ? studying
                  : Number(learnProgressInfoData.bookLevel) === 2
                    ? afterStudying
                    : completeAll
              }
              alt=""
              className="relative z-10"
            />
            <Bg1Icon className="absolute top-[4px] left-[16px]" />
            <Bg2Icon className="absolute top-[8px] left-[20px]" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center text-[#9ea6b8] text-[12px] font-['PingFang SC'] mt-[12px]">
              <span className="pr-[6px]">
                Lv{learnProgressInfoData.bookLevel}.
              </span>
              <span className="truncate">
                {learnProgressInfoData.textBookName}
              </span>
            </div>
            <div className="text-[#141413] text-[16px] font-semibold font-['PingFang SC'] truncate">
              <Tooltip title={learnProgressInfoData.catalogName}>
                {learnProgressInfoData.catalogName}
              </Tooltip>
            </div>
            <div className="relative h-[4px] mt-[20px] bg-[#d9e0eb] rounded-md w-[120px]">
              <div
                className="absolute h-[4px] bg-[#00bc12] rounded-md"
                style={{
                  width: `${learnProgressInfoData?.learnProgress || 2}%`,
                }}
              ></div>
            </div>
          </div>
        </div>
        <div
          className="flex justify-center items-center w-[84px] h-8 bg-[#232a37] rounded-lg text-white text-xs font-normal font-['PingFang SC'] cursor-pointer pl-[6px] mt-[34px] flex-shrink-0 ml-[8px] hover:opacity-70 transition duration-300"
          onClick={() =>
            btnClick(
              learnProgressInfoData.learnRouteStatus === LearnStatus.notStart
                ? null
                : (learnProgressInfoData.learnRouteStatus ===
                      LearnStatus.learning &&
                      learnProgressInfoData.learnBookStatus ===
                        LearnStatus.notStart) ||
                    learnProgressInfoData.learnRouteStatus ===
                      LearnStatus.complete
                  ? Target.lesson
                  : Target.course
            )
          }
          data-bury-id="fefb0e3a-7414-4612-b134-4ac5c3c7a604"
        >
          {learnProgressInfoData.learnRouteStatus === LearnStatus.complete
            ? getLang("college")
            : learnProgressInfoData.learnRouteStatus === LearnStatus.notStart
              ? getLang("register_now")
              : learnProgressInfoData.learnRouteStatus ===
                    LearnStatus.learning &&
                  learnProgressInfoData.learnBookStatus === LearnStatus.exam
                ? getLang("go_and_verify")
                : learnProgressInfoData.learnRouteStatus ===
                      LearnStatus.learning &&
                    learnProgressInfoData.learnBookStatus ===
                      LearnStatus.notStart
                  ? getLang("start_learning")
                  : getLang("continue_learning")}
          <RightBlackIcon />
        </div>
      </div>
      <div className="flex justify-between items-center text-[#445166] text-[12px] mt-[12px] px-[16px]">
        <span>{getLang("after_completing_the_course_you_can_enjoy")}</span>
        <span className="flex items-center">
          <BadgeIcon className="mr-[8px]" />
          {getLang("RPA_professional_certificate")}
        </span>
        <span className="flex items-center">
          <BadgeIcon className="mr-[8px]" />
          {getLang("achievement_unlocked")}
        </span>
        <span className="flex items-center">
          <BadgeIcon className="mr-[8px]" />
          {getLang("benefitting_lifelong_skills")}
        </span>
      </div>
    </div>
  );
};
