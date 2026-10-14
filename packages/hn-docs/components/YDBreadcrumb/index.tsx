import React, { useEffect, useRef, useState } from "react";
import { HomeOutlined } from "@ant-design/icons";
import { Breadcrumb } from "antd";
import { useRouter } from "next/router";

import { getLang } from "@/utils/getLang";
import { env } from "@/utils/env";

import "./index.css";

const YDBreadcrumb = ({ breadcrumbData }) => {
  const measureRef = useRef<HTMLDivElement>(null); // 隐藏容器
  const [breadcrumbItems, setBreadcrumbItems] = useState([]); // 面包屑数据
  const router = useRouter();
  const languageCode = router.query.languageCode as string | undefined;
  const brandCode = router.query.brandCode as string | undefined;
  // 使用统一的 env.BASE_PATH 获取路径前缀
  const baseUrl = env.BASE_PATH;

  useEffect(() => {
    adjustBreadcrumb(breadcrumbData);
  }, [JSON.stringify(breadcrumbData)]);

  const adjustBreadcrumb = (data) => {
    if (!measureRef.current) return;
    data.map((item) => {
      const span = document.createElement("span");
      span.style.whiteSpace = "nowrap";
      span.style.fontSize = "14px";
      span.innerHTML = item.title;
      measureRef.current?.appendChild(span);
      console.log(data);
      if (item.type !== "doc") {
        item.href = `${baseUrl}/${brandCode}/${languageCode}/help?id=${item.id}`;
      }
    });

    let area = measureRef.current?.offsetWidth;
    const publicAreaWidth = 90 + 20 * data.length;
    const windowWidth = window.innerWidth - 52;

    // 需要重写面包屑数据
    if (windowWidth < area + publicAreaWidth) {
      // 如果除面包屑数据的最后一个的总长度小于当前窗口宽度，则不需要处理，对最后一个做...处理，否则重写中间数据为...
      //删除 measureRef.current得最后一个子元素
      measureRef.current?.removeChild(measureRef.current.lastChild);

      if (windowWidth < measureRef.current?.offsetWidth + publicAreaWidth) {
        setBreadcrumbItems([{ title: "..." }, data[data.length - 1]]);
      } else {
        setBreadcrumbItems(data);
      }
    } else {
      setBreadcrumbItems(data);
    }
  };

  return (
    <>
      <div
        ref={measureRef}
        style={{
          position: "absolute",
          visibility: "hidden",
          height: 0,
          overflow: "hidden",
          whiteSpace: "nowrap",
        }}
      />
      <Breadcrumb
        className="custom-breadcrumb"
        items={[
          {
            title: <HomeOutlined />,
            href: `${baseUrl}/${brandCode}/${languageCode}?referrer=rpa-win`,
          },
          {
            title: getLang("help_center"),
            href: `${baseUrl}/${brandCode}/${languageCode}/help`,
          },
          ...breadcrumbItems,
        ]}
      />
    </>
  );
};

export default YDBreadcrumb;
