import { getLang } from "@/utils/getLang";

import "./index.css";

interface FileSourceProps {
  chunk: string;
  dataType: string;
  datasetUuid: string;
  docFileName: string;
  docFileUrl: string;
  docUuid: string;
  score: string;
  status: string;
  tenantUuid: string;
}

export default function FileSource({ dataSource }: { dataSource: any[] }) {
  return (
    <div className="w-full">
      <span className="text-[#1f2633] text-[13px] font-['PingFang SC']">
        {getLang("more_information")}
      </span>
      <div>
        {dataSource.map((doc: FileSourceProps, index: number) => (
          <a
            className="relative pl-[15px] text-[#1f2633] block text-[13px] font-normal font-['PingFang SC'] underline leading-[24px] hover:text-[#1f2633] file-source"
            href={doc.docFileUrl}
            key={index}
          >
            {doc.docFileName}
          </a>
        ))}
      </div>
    </div>
  );
}
