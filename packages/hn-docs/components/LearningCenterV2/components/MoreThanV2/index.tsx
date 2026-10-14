"use client";



import WebsiteIcon from "/static/img/website.svg";

import { getLang } from "@/utils/getLang";
import "./index.css";

const moreSupports = [
  {
    title: getLang("official_website"),
    url: getLang("official_website_url"),
    icon: <WebsiteIcon />,
  },
];

export default () => {


  return (
    <div className="mt-[14px] font-pingfang-sc bg-white pt-[14px] pb-[16px] rounded-[8px]">
      <div className="text-[14px] text-[#1f2633] font-semibold font-['PingFang SC'] px-[16px]">
        没有找到想要的？
      </div>
      <div className="flex justify-between items-center mt-[16px] px-[8px]">
        {moreSupports.map((item, index) => (
          <div
            key={index}
            className="flex justify-between items-center cursor-pointer hover:bg-[#f4f6f9] rounded-[4px] px-[8px] transition-colors duration-300"
            onClick={() => {
                window.open(item.url);
            }}
            data-bury-id="f581b892-5a49-4da5-8add-e6557da2a00e"
          >
            {item.icon}
            <span className="text-[#1F2633] text-[13px] pl-[10px]">
              {item.title}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
