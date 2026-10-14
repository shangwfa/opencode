"use client";
import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/router";
import { cn } from "@/lib/utils";

import type { EditorData } from "../types";
import { getTextContent } from "../utils";

interface AnchorItem {
  id: string;
  title: string;
  level: number;
}

interface AnchorMenuProps {
  docData: EditorData;
}
interface Item {
  type: string;
  content: any[];
  attrs: {
    level: number;
    id: string;
  };
}

// 允许锚点的标题级别
const levels = [1, 2, 3];

export default function AnchorMenu({ docData }: AnchorMenuProps) {
  const [anchorList, setAnchorList] = useState<AnchorItem[]>([]);
  const [activeId, setActiveId] = useState<string>(""); // 当前激活的锚点 ID
  const isClickingRef = useRef(false); // 标记是否正在执行点击跳转
  const hasInitializedRef = useRef(false); // 标记是否已初始化 Hash 跳转
  const router = useRouter();

  const getAnchorData = () => {
    let list: AnchorItem[] = [];
    docData?.content?.forEach((item: Item) => {
      if (item.type === "heading" && item.content) {
        list.push({
          id: item.attrs.id,
          title: getTextContent(item),
          level: item.attrs.level,
        });
      }
    });
    setAnchorList(list);
  };

  useEffect(() => {
    getAnchorData();
  }, [JSON.stringify(docData)]);

  // 页面加载时，如果 URL 中有 hash，自动滚动到对应位置
  useEffect(() => {
    if (typeof window === "undefined" || anchorList.length === 0) return;

    const hash = decodeURIComponent(window.location.hash.slice(1)); // 移除 # 号并解码 URL 编码
    if (hash && !hasInitializedRef.current) {
      hasInitializedRef.current = true; // 标记已初始化
      isClickingRef.current = true; // 锁定滚动监听

      // 保存原始 Hash，用于恢复
      const originalHash = window.location.hash;

      // 尽快跳转，减少延迟
      setTimeout(() => {
        const element = document.getElementById(hash);
        if (element) {
          const elementPosition = element.getBoundingClientRect().top;
          const offsetPosition = elementPosition + window.pageYOffset - 90;
          window.scrollTo({
            top: offsetPosition,
            behavior: "auto", // 立即跳转
          });

          // 设置为激活状态
          setActiveId(hash);

          // 确保 URL Hash 保持不变
          if (!window.location.hash) {
            window.history.replaceState(null, "", originalHash);
          }

          // 延迟解锁，防止滚动监听干扰
          setTimeout(() => {
            isClickingRef.current = false;
          }, 500); // 增加到 500ms 防止自动滚动
        }
      }, 100); // 减少到 100ms
    }
  }, [anchorList]);

  // 监听页面滚动，高亮当前可视区域的标题
  useEffect(() => {
    if (typeof window === "undefined" || anchorList.length === 0) return;

    const handleScroll = () => {
      // 如果正在执行点击跳转或初始化跳转，跳过滚动监听的判断
      if (isClickingRef.current) {
        return;
      }

      // 获取所有标题元素的位置
      // 使用较小的偏移量来判断当前激活的标题
      const scrollPosition = window.scrollY + 100;

      // 找出当前滚动位置对应的标题
      let currentId = "";

      for (let i = anchorList.length - 1; i >= 0; i--) {
        const anchor = anchorList[i];
        if (!anchor) continue;

        const element = document.getElementById(anchor.id);

        if (element) {
          const elementTop =
            element.getBoundingClientRect().top + window.pageYOffset;

          if (scrollPosition >= elementTop) {
            currentId = anchor.id;
            break;
          }
        }
      }

      // 只更新高亮状态，不修改 URL
      if (currentId && currentId !== activeId) {
        setActiveId(currentId);
      }
    };

    // 添加滚动监听
    window.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      window.removeEventListener("scroll", handleScroll);
    };
  }, [anchorList, activeId]);

  // 滚动到锚点的通用函数
  const scrollToAnchor = (anchorId: string) => {
    const element = document.getElementById(anchorId);
    if (element) {
      let headerHeight = 0;
      const header = document.querySelector("header");
      if (header) {
        headerHeight = header.offsetHeight;
      }
      const defaultOffset = 114;
      const extraSpace = -20;
      const offset = (headerHeight || defaultOffset) + extraSpace;
      const elementPosition = element.getBoundingClientRect().top;
      const offsetPosition = elementPosition + window.pageYOffset - offset;
      window.scrollTo({
        top: offsetPosition,
        behavior: "auto",
      });
    }
  };

  const onAnchorClick = (anchorItem: AnchorItem) => {
    isClickingRef.current = true;
    if (typeof window !== "undefined") {
      const newUrl = `${window.location.pathname}${window.location.search}#${anchorItem.id}`;
      window.history.pushState(null, "", newUrl);
    }
    setActiveId(anchorItem.id);
    scrollToAnchor(anchorItem.id);
    setTimeout(() => {
      isClickingRef.current = false;
    }, 100);
  };

  const renderNavItem = (anchorItem: AnchorItem, index: number) => {
    if (levels.includes(anchorItem.level)) {
      const marginLeft = (anchorItem.level - 1) * 12;
      const isActive = activeId === anchorItem.id;

      return (
        <li
          key={anchorItem.id + index}
          className={cn("mb-[4px] cursor-pointer transition-all")}
          style={{ marginLeft: `${marginLeft}px` }}
          onClick={() => onAnchorClick(anchorItem)}
          data-bury-id="2b3db176-c59c-4fa2-a990-de75464f2cf0"
        >
          <a
            className={cn(
              "text-[14px] break-all transition-colors",
              isActive
                ? "text-[#1677ff] font-semibold"
                : "text-[#757c8f] hover:text-[#192544]",
            )}
          >
            {anchorItem.title}
          </a>
        </li>
      );
    }
    return null;
  };

  return (
    <nav
      className="fixed top-[114px] left-[1200px] z-10 m-0 p-0 overflow-y-auto bg-white"
      style={{
        maxHeight: "calc(90vh - 144px)",
        borderLeft: "1px solid #e5e7eb",
        paddingLeft: "20px",
      }}
    >
      <ul>
        {anchorList.map((anchorItem: AnchorItem, index) =>
          renderNavItem(anchorItem, index),
        )}
      </ul>
    </nav>
  );
}
