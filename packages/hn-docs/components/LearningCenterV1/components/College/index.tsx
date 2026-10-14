"use client";

import React, { useEffect, useState } from "react";
import Image from "next/image";

import { learnProgressInfo } from "@/api/college";
import { createJumpToken, proxyToken } from "@/api/account";
import { getLang } from "@/utils/getLang";
import { env } from "@/utils/env";

import junior_certificate from "/static/img/junior_certificate.png";
import intermediate_certificate from "/static/img/intermediate_certificate.png";
import senior_certificate from "/static/img/senior_certificate.png";

enum Level {
  junior_certificate = 1,
  intermediate_certificate = 2,
  senior_certificate = 3,
}
interface UserCertVO {
  level: Level;
}
interface LearnProgressInfoData {
  learnStatus: string;
  textBookName: string;
  learnProgress: number;
  userCertVO: UserCertVO;
}

const LEVEL_INFO = {
  1: {
    level: "junior_certificate",
    icon: junior_certificate,
    btnText: `${getLang("continue_to_challenge")} >`,
    levelText: getLang("junior_certificate"),
  },
  2: {
    level: "junior_certificate",
    icon: junior_certificate,
    btnText: `${getLang("continue_to_challenge")} >`,
    levelText: getLang("junior_certificate"),
  },
  3: {
    level: "intermediate_certificate",
    icon: intermediate_certificate,
    btnText: `${getLang("continue_to_challenge")} >`,
    levelText: getLang("intermediate_certificate"),
  },
  4: {
    level: "senior_certificate",
    icon: senior_certificate,
    btnText: `${getLang("learn_more")} >`,
    levelText: getLang("advanced_certificate"),
  },
};

interface Props {
  isHybrid: boolean;
}

export default (props: Props) => {
  const { isHybrid } = props;
  const [learnProgressInfoData, setLearnProgressInfoData] =
    useState<LearnProgressInfoData>({
      learnStatus: "",
      textBookName: "",
      learnProgress: 0,
      userCertVO: {
        level: Level.junior_certificate,
      },
    });

  useEffect(() => {
    getLearnProgressInfo();
  }, []);

  // 提供已报名的学院用户学习信息
  const getLearnProgressInfo = () => {
    learnProgressInfo().then((res) => {
      if (res.code === 200) {
        setLearnProgressInfoData(res.data);
      }
    });
  };

  const openLessonLink = async (token) => {
    const url = `${env.COLLEGE_BASE_URL}/lesson?token=${token}`;
    window.open(url, "_blank");
  };

  const btnClick = async () => {
    if (isHybrid) {
      const res = await proxyToken();
      if (res.code === 200) {
        await openLessonLink(res.data);
      }
      return;
    }

    if (env.ENV !== "private") {
      const res = await createJumpToken();
      if (res.code === 200) {
        await openLessonLink(res.data.accessToken);
      }
    }
  };

  return (
    <div className="my-[24px] font-pingfang-sc">
      <div className="relative mb-[20px] bg-cover bg-center rounded-lg college-process">
        {learnProgressInfoData?.learnStatus === "notStart" && (
          <div className="relative p-[35px] px-[27px] pb-[32px]">
            <p className="text-gray-900 font-semibold text-[22px] leading-[30px] text-left mb-[4px]">
              {getLang("in_the_era_of_automation")}
            </p>
            <button
              className="mt-[10px] px-[16px] py-[8px] text-white font-semibold text-sm leading-[22px] bg-blue-500 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-600 hover:bg-blue-600 transition-colors duration-300"
              onClick={() => btnClick()}
              data-bury-id="d63028f3-9eeb-4393-bcd8-f56b101cba91"
            >
              {getLang("start_obstacle_based_learning")}
            </button>
          </div>
        )}
        {learnProgressInfoData?.learnStatus === "learning" && (
          <div className="px-[20px] py-[17px]">
            <div className="text-gray-600 font-normal text-base leading-[26px]">
              {getLang("diligence_in_learning_is_like_a_spring_seedling")}
            </div>
            <div className="flex items-center justify-between mt-[6px] overflow-hidden text-gray-900 font-pingfang-sc leading-[28px]">
              <span className="w-full overflow-hidden font-medium text-lg leading-[32px] whitespace-nowrap overflow-ellipsis">
                {learnProgressInfoData?.textBookName}
              </span>
              <span className="text-gray-900 font-medium text-base whitespace-nowrap">
                <span className="pr-[8px]">
                  {getLang("progress_of_passing_levels")}:
                </span>
                {learnProgressInfoData?.learnProgress}%
              </span>
            </div>
            <div className="relative h-[4px] mt-[12px] mb-[8px] bg-white rounded-md">
              <div
                className="absolute w-full h-[4px] bg-blue-500 rounded-md"
                style={{
                  width: learnProgressInfoData?.learnProgress + "%",
                }}
              >
                <div className="absolute top-[-6px] right-[-8px] w-[16px] h-[16px] bg-blue-500 border-[2px] border-white rounded-full"></div>
              </div>
            </div>
            <button
              className="mt-[16px] px-[16px] py-[8px] text-white font-semibold text-sm leading-[22px] bg-blue-500 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-600 hover:bg-blue-600 transition-colors duration-300"
              onClick={() => btnClick()}
              data-bury-id="df47a3ab-10de-42b5-8a9e-5fbff1d3e3a9"
            >
              {getLang("continue_to_pass_the_level")} &gt;
            </button>
          </div>
        )}
        {learnProgressInfoData.learnStatus === "complete" &&
          learnProgressInfoData?.userCertVO && (
            <div className="relative p-[20px]">
              <div className="text-gray-900 text-[12px]">
                <div className="mt-[12px] text-gray-600 font-normal text-[14px] leading-[26px]">
                  {getLang("congratulations")}
                </div>
                <p className="mt-[4px] text-gray-900 font-medium text-[20px] leading-[32px]">
                  {getLang("obtain")}
                  <em className="text-blue-600 font-normal">
                    {
                      LEVEL_INFO[learnProgressInfoData?.userCertVO?.level]
                        .levelText
                    }
                  </em>
                </p>
              </div>
              <Image
                src={LEVEL_INFO[learnProgressInfoData?.userCertVO?.level].icon}
                className="absolute top-[22px] right-[14px] w-[190px]"
                width={190}
                height={135}
                alt="RPA"
              />

              <button
                className="mt-[16px] mb-[10px] px-[16px] py-[8px] text-white font-semibold text-sm leading-[22px] bg-blue-500 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-600 hover:bg-blue-600 transition-colors duration-300"
                onClick={() => btnClick()}
                data-bury-id="a24a8403-61db-4c1c-bcfd-c1ab705e7c48"
              >
                {LEVEL_INFO[learnProgressInfoData?.userCertVO?.level].btnText}
              </button>
            </div>
          )}
      </div>
    </div>
  );
};
