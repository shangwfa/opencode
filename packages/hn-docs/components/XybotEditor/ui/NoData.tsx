"use client";
import { type DocInfo } from "../types";

import NoDataIcon from "/static/img/noData.svg";
import { getLang } from "@/utils/getLang";

interface Props {
  docInfo: DocInfo;
}

export default function NoData({ docInfo }: Props) {
  return (
    <div className="m-auto my-[150px] grid place-items-center">
      <NoDataIcon />
      <div className="text-center text-[#00000073] mt-[12px]">
        {getLang(docInfo.hasDraft ? "coming_soon" : "empty")}
      </div>
    </div>
  );
}
