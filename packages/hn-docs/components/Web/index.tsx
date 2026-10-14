import React, { useState, useEffect } from "react";
import { Modal } from "antd";
import { useRouter } from "next/router";

import { getListBySceneCode } from "@/api/public";
import { RequestSource } from "@/api/index.d";

import NoData from "./components/NoData";

import banner_icon from "/static/icon/banner_icon.png";

export const Web: React.FC<{}> = (p) => {
  const [videoList, setVideoList] = useState([]);
  const [helpList, setHelpList] = useState([]);
  const [selectVideo, setSelectVideo] = useState("");
  const [visible, setVisible] = useState(false);

  const router = useRouter();
  const { brandCode } = router.query;

  useEffect(() => {
    if (brandCode) {
      bannerList();
    }
  }, [brandCode]);

  // banner
  const bannerList = () => {
    getListBySceneCode({
      sceneCodes:
        brandCode === RequestSource.RPA
          ? "quickStart,HelpCenter"
          : `${brandCode}_quickStart,${brandCode}_HelpCenter"`,
    }).then((res) => {
      if (res.code === 200) {
        const buildVideoCode = () => {
          const { quickStart = {}, HelpCenter = {} } = res.data || {};
          let { dataSources = [] } = quickStart;
          let { contents = [] } = dataSources[0] || {};
          let { contentInfos = [] } = contents[0] || {};
          setVideoList(contentInfos);
        };
        const buildHelpCenter = () => {
          const { videoCode = {}, HelpCenter = {} } = res.data || {};
          let { dataSources = [] } = HelpCenter;
          let { contents = [] } = dataSources[0] || {};
          let { contentInfos = [] } = contents[0] || {};
          const helpObj = {};
          contentInfos.map((item) => {
            if (helpObj.hasOwnProperty(item.contentTag)) {
              if (!item.contentLogoUrl) {
                helpObj[item.contentTag].child.push(item);
              }
            } else {
              helpObj[item.contentTag] = { ...item, child: [] };
            }
          });
          setHelpList(Object.values(helpObj));
        };
        buildVideoCode();
        buildHelpCenter();
      }
    });
  };
  // 视频唤起客户端
  const handleVideoPlay = (item: any) => {
    if (window.CefSharp) {
      (async function () {
        const res = await window.CefSharp?.BindObjectAsync("javascriptBinding");
        window.javascriptBinding?.watchVideo?.(
          item.contentTitle,
          item.contentVideoUrl
        );
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

  return (
    <div>
      {videoList.length || helpList.length ? (
        <>
          {process.env.ENV != "private" ? (
            <div className="w-full h-[200px] pl-[50px]">
              <div className="mx-auto">
                <div className="h-[180px] border-b border-solid border-gray-300">
                  <ul className="p-0 list-none">
                    {videoList.slice(0, 2).map((item: any, index) => {
                      return (
                        <li
                          key={index}
                          onClick={() => {
                            !item?.contentJumpUrl
                              ? handleVideoPlay(item)
                              : handleJump(item);
                          }}
                          className="relative float-left w-[185px] h-[150px] mr-[24px] overflow-hidden bg-white border border-solid border-gray-300 rounded-tl-md rounded-tr-md rounded-bl-lg rounded-br-lg cursor-pointer transition-all duration-300"
                          data-bury-id="0f75aaae-b31e-45ef-8180-c3f8ca666bee"
                        >
                          <img
                            src={item.contentUrl}
                            className="w-[185px] h-[105px]"
                          />
                          {!item?.contentJumpUrl ? (
                            <div className="absolute top-0 left-0 w-[185px] h-[105px] bg-black bg-opacity-30 invisible">
                              <img
                                src={banner_icon}
                                className="absolute top-1/2 left-1/2 w-[48px] h-[48px] mt-[24px] ml-[24px]"
                              />
                            </div>
                          ) : null}
                          <p className="mt-[12px] ml-[8px] text-[14px]">
                            {item.contentTitle}
                          </p>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            </div>
          ) : null}
          <div className="mx-auto ml-0 pl-[25px] web-content">
            <ul className="m-0 mt-[10px] p-0 list-none">
              {helpList.map((item: any, index: number) => {
                return (
                  <li
                    key={index}
                    className="float-left w-[297px] h-[254px] mr-[40px] pt-[30px] pl-[25px]"
                  >
                    <div className="font-semibold leading-6">
                      <a
                        href={item.contentJumpUrl}
                        className="text-gray-900 text-base flex items-center"
                      >
                        <img
                          src={item.contentLogoUrl}
                          className="w-[24px] mr-[14px]"
                        />
                        {item.contentTitle}
                      </a>
                    </div>
                    <div className="mt-[14px] pl-[35px]">
                      {item.child.map((items: any, idx: number) => {
                        return (
                          <a
                            key={index + "_" + idx}
                            href={items.contentJumpUrl}
                            className="block text-gray-700 font-normal text-[14px] leading-8 whitespace-nowrap overflow-hidden overflow-ellipsis hover:text-gray-900"
                          >
                            &nbsp;{items.contentTitle}
                          </a>
                        );
                      })}
                    </div>
                    <a
                      href={item.contentJumpUrl}
                      className="block mt-[16px] pl-[38px] text-blue-500 font-normal text-[14px]"
                    >
                      {item.contentBtnName}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
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
      ) : (
        <NoData />
      )}
    </div>
  );
};
export default Web;
