import React, { useRef } from "react";
import { SearchOutlined } from "@ant-design/icons";
import { Input } from "antd";

import { useIsYdBrowser } from "@/hooks";
import { replaceUrlParams, recordLog } from "@/utils";

import { useJumpUrl } from "@/hooks/jump-url";

import "./index.css";
import { getLang } from "@/utils/getLang";

interface Iprops {
  keywords: string;
  onKeyChange: (key: string) => void;
}

export default (props: Iprops) => {
  const { keywords, onKeyChange } = props;
  const timer: any = useRef();
  const keywordsLog: any = useRef();
  const jumpUrl = useJumpUrl();

  const getAnswers = (key: string) => {
    keywordsLog.current = key;
    if (key) {
      onKeyChange && onKeyChange(key);
      replaceUrlParams("keywords", key);
    } else {
      window.location.href = jumpUrl("help");
    }
  };
  const isYd = useIsYdBrowser();

  // 返回首页
  const onGoHome = () => {
    window.location.href = jumpUrl();
  };
  return (
    <div
      className="fixed top-0 right-0 left-0 z-50 px-[20px] py-[14px] bg-white shadow-md"
      style={{ top: isYd ? "0px" : "61px" }}
    >
      <div className="flex items-center h-[52px] leading-[52px] search-portal">
        <Input
          value={keywords}
          allowClear={true}
          prefix={
            <SearchOutlined style={{ marginRight: "8px", color: "#7A889E" }} />
          }
          placeholder={getLang("what_can_we_help_you_find")}
          onChange={(e) => getAnswers(e.target.value)}
          onFocus={(e) => {
            timer.current = window.setInterval(() => {
              if (keywordsLog.current) {
                recordLog(keywordsLog.current);
              }
            }, 15 * 1000);
          }}
          onBlur={() => {
            window.clearInterval(timer.current);
          }}
        />
        <span
          className="inline-block w-[38px] ml-[14px] text-gray-700 font-normal text-[16px] cursor-pointer hover:text-gray-900"
          onClick={() => onGoHome()}
          data-bury-id="21b481e3-258e-4055-8bf3-01b5a6b23703"
        >
          {getLang("cancel")}
        </span>
      </div>
    </div>
  );
};
