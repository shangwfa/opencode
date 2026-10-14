"use client";

import React, { useState } from "react";
import { Row, Col, Modal } from "antd";
import { RightOutlined } from "@ant-design/icons";
import Image from "next/image";

import { init as initBridge } from "@/utils/native-bridge";
import { getLang } from "@/utils/getLang";
import { env } from "@/utils/env";

import { createJumpToken } from "@/api/account";

import recognize from "/static/img/recognize.png";

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
  videoTutorial: ContentInfo[];
  videoTutorialMore: string;
  isHybrid: boolean;
}

export default (props: Props) => {
  const { videoTutorial, videoTutorialMore, isHybrid } = props;
  const [selectVideo, setSelectVideo] = useState("");
  const [visible, setVisible] = useState(false);

  const isInternational = env.ENV == "international";

  // 点击学习跳转
  const jumpVideo = () => {
    if (isInternational) {
      return window.open(videoTutorialMore, "_blank");
    }
    createJumpToken().then((res) => {
      if (res.code === 200) {
        window.open(videoTutorialMore + "?token=" + res.data, "_blank");
      }
    });
  };
  // 视频唤起客户端
  const handleVideoPlay = (item: any) => {
    // ANCHOR 区分客户端与web端
    if (window.CefSharp) {
      (async function () {
        await initBridge().then(({ javascriptBinding }) => {
          javascriptBinding?.watchVideo?.(
            item.contentTitle,
            item.contentVideoUrl
          );
        });
      })();
    } else {
      setSelectVideo(item.contentVideoUrl);
      setVisible(true);
    }
  };

  const handleJump = (item: any) => {
    const { contentJumpUrl } = item;
    window.open(contentJumpUrl, "__blank");
  };

  const btnClick = () => {
    createJumpToken().then((res) => {
      if (res.code === 200) {
        window.open(
          env.COLLEGE_BASE_URL +
            "/lesson?token=" +
            res.data,
          "_blank"
        );
      }
    });
  };

  return (
    <>
      {/* 视频教程 */}
      {videoTutorial.length > 0 &&
      (env.ENV != "private" || isHybrid) ? (
        <div className="my-[24px] font-pingfang-sc">
          <div className="mb-[16px] font-medium text-[16px] font-pingfang leading-[22px]">
            {getLang("tutorial")}
            <span
              className="float-right text-blue-500 font-normal text-base cursor-pointer hover:text-blue-700"
              onClick={() => {
                jumpVideo();
              }}
              data-bury-id="af262a39-bb32-495f-b7cf-f05e38dfe699"
            >
              {getLang("more")}
              <RightOutlined />
            </span>
          </div>
          <div>
            <Row gutter={8}>
              {videoTutorial.slice(0, 4).map((item: any, index) => {
                return (
                  <Col
                    span={12}
                    key={index}
                    onClick={() => {
                      !item?.contentJumpUrl
                        ? handleVideoPlay(item)
                        : handleJump(item);
                    }}
                    data-bury-id="5f2a6827-166a-4d11-aff3-d53d0b5cbf9f"
                  >
                    <div className="relative">
                      {isHybrid ? (
                        <Image
                          src={recognize}
                          className="w-full rounded-lg"
                          layout="responsive" // 使图像响应式
                          width={183}
                          height={114}
                          alt="RPA"
                        />
                      ) : (
                        <img
                          src={item.contentUrl}
                          alt=""
                          className="w-full rounded-lg"
                        />
                      )}

                      <div className="absolute inset-0 bg-black bg-opacity-25 rounded-lg cursor-pointer opacity-0">
                        <span className="absolute top-1/2 left-1/2 hidden w-[29px] h-[29px] bg-opacity-50 bg-blue-800 rounded-full transform -translate-x-1/2 -translate-y-1/2 cursor-pointer">
                          <span className="absolute top-[8px] left-[12px] inline-block border-solid border-transparent border-t-[7px] border-b-[7px] border-l-[10px] border-white"></span>
                        </span>
                      </div>
                    </div>
                    <span className="absolute right-[14px] bottom-[8px] px-[2px] py-0 text-white text-xs leading-[5px] bg-black bg-opacity-35 rounded-md">
                      {item.contentTip}
                    </span>
                  </Col>
                );
              })}
            </Row>
          </div>
        </div>
      ) : null}
      {/* 获得支持 */}
      <Modal
        destroyOnClose
        onCancel={() => setVisible(false)}
        open={visible}
        title={false}
        footer={false}
      >
        <video
          src={selectVideo}
          width="100%"
          style={{
            marginTop: "20px",
          }}
          height="100%"
          autoPlay
          controls
          loop
        ></video>
      </Modal>
    </>
  );
};
