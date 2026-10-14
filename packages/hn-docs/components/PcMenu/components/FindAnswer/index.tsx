import React, { useEffect, useRef, useState, useCallback } from "react";
import { Input } from "antd";
import { SearchOutlined } from "@ant-design/icons";

import { getUrlParams, replaceUrlParams, recordLog, debounce } from "@/utils";
import { getLang } from "@/utils/getLang";
import "./index.css";

export const FindAnswer: React.FC<{
  onKeyChange: (key: string) => void;
}> = (props) => {
  const { onKeyChange } = props;
  const [searchValue, setSearchValue] = useState("");
  const [isComposing, setIsComposing] = useState(false);
  const timer: any = useRef();
  const keywordsLog: any = useRef();

  useEffect(() => {
    getAnswers(getUrlParams("keywords")?.substring(0, 500));
  }, []);

  const getAnswers = useCallback(
    debounce((key: string) => {
      keywordsLog.current = key;
      debounce(() => {
        onKeyChange && onKeyChange(key);
      }, 500)();

      replaceUrlParams("keywords", key);
    }, 500),
    []
  );

  const onChange = (e: any) => {
    const val = e.target?.value || "";
    setSearchValue(val);

    // 只有在输入法未激活时才触发防抖搜索
    if (!isComposing) {
      getAnswers(e.target.value);
    }
  };

  const onCompositionStart = () => {
    setIsComposing(true); // 输入法激活
  };

  const onCompositionEnd = (e: any) => {
    setIsComposing(false); // 输入法输入完成
    getAnswers(e.target.value);
  };

  return (
    <div className="mb-[24px] find-answer">
      <div className="h-[18px] mb-3 text-gray-700 font-semibold text-sm font-pingfang whitespace-nowrap">
        {getLang("knowledge_base")}
      </div>
      <Input
        placeholder={getLang("what_can_we_help_you_find")}
        onChange={onChange}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
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
        maxLength={500}
        value={searchValue}
        prefix={
          <SearchOutlined
            style={{
              color: "#ABB1BD",
              marginRight: "4px",
            }}
          />
        }
      />
    </div>
  );
};

export default FindAnswer;
