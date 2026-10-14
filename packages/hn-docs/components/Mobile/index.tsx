"use client";

import React from "react";

import LearningCenterV1 from "../LearningCenterV1";
import LearningCenterV2 from "../LearningCenterV2";
import MobileBg from "../MobileBg";

import { useClientVersion } from "@/hooks";

export const Mobile: React.FC<{}> = (p) => {
  const { version, isLoading } = useClientVersion();
  return (
    <>
      {!isLoading && (
        <>
          {!version ? (
            <LearningCenterV1 />
          ) : (
            <MobileBg>
              <LearningCenterV2 />
            </MobileBg>
          )}
        </>
      )}
    </>
  );
};
export default Mobile;
