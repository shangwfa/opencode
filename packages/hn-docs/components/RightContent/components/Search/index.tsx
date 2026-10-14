import React, { useEffect, useRef, useState } from "react";
import { SearchOutlined, LeftOutlined } from "@ant-design/icons";
import { Input } from "antd";

import { getUrlParams, replaceUrlParams, recordLog } from "@/utils";
import { getLang } from "@/utils/getLang";

import "./index.css";

type Props = {
  onKeyChange?: (key: string) => void;
  style?: React.CSSProperties;
};

export default (p: Props) => {
  const { onKeyChange, style } = p;
  const inputRef = useRef<any>(null);
  const [keywords, setKeywords] = useState("");
  const timer: any = useRef();
  const keywordsLog: any = useRef();

  const getAnswers = (key: string) => {
    keywordsLog.current = key;
    onKeyChange && onKeyChange(key);
    replaceUrlParams("keywords", key);
    setKeywords(key);
  };

  useEffect(() => {
    const value = getUrlParams("keywords");
    setKeywords(value);
    getAnswers(value);
  }, []);

  return (
    <div
      className="flex items-center h-[80px] mb-[18px] px-[20px] py-[15px] bg-white shadow-lg"
      style={style}
    >
      <div className="icon-box">
        <LeftOutlined
          style={{ color: "#7A889E" }}
          onClick={() => history.go(-1)}
          data-bury-id="39470530-0dd3-4f67-ac1e-2966bf190cce"
        />
      </div>
      <div className="search-input">
        <Input
          value={keywords}
          ref={inputRef}
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
      </div>
    </div>
  );
};
