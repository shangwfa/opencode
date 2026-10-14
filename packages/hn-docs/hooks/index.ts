import { useState, useEffect, useRef } from "react";
import { sendBuryById } from "@xybot/bury";

import { useSharedData } from "@/context/SharedDataContext";
import { init as initBridge, clientVersion } from "@/utils/native-bridge";
import { getSearch } from "@/api/public";
import { debounce } from "@/utils";

import { Version } from "@/api/index.d";

let canChangeSize = true;
export const usePcMobile = () => {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    document.addEventListener("mouseover", (e) => {
      if (e.target.nodeName == "VIDEO") {
        canChangeSize = false;
      } else {
        canChangeSize = true;
      }
    });

    console.log("useEffect setIsMobile:" + window.innerWidth);
    setIsMobile(window.innerWidth <= 800);
    window.addEventListener("resize", (e) => {
      // FIXME 鼠标hover在video上时候 不切换样式
      // 如果切换会导致全屏按钮无法使用
      if (canChangeSize) {
        debounce(() => {
          setIsMobile(window.innerWidth <= 800);
        }, 500)();
      }
    });
  }, []);
  return isMobile;
};

export const useIsYdBrowser = () => {
  const [isYd, setIsYd] = useState(false);
  useEffect(() => {
    setIsYd(!!window.CefSharp);
  }, []);
  return isYd;
};

// 判断客户端版本
type VersionResult = {
  version: string | null;
  isLoading: boolean;
};

let versionStatus = "";
export const useClientVersion = (): VersionResult => {
  const [version, setVersion] = useState<string | null>(null); // 初始为 null 表示未加载
  const [isLoading, setIsLoading] = useState(true); // 新增加载状态态

  useEffect(() => {
    if (versionStatus) {
      setIsLoading(false);
      setVersion(versionStatus);
      return;
    }
    const getClientVersion = async () => {
      try {
        await initBridge();
        const res = await clientVersion();
        setVersion(res);
        versionStatus = res;
      } catch (error) {
        setVersion(null);
      } finally {
        setIsLoading(false);
      }
    };
    getClientVersion();
  }, []);

  return { version, isLoading };
};

// 查找节点并返回路径的辅助函数
function findPath(data, targetId) {
  let path = [];
  function recurse(nodes, currentPath) {
    for (let node of nodes) {
      if (node.id === targetId || node.slug === targetId) {
        path = [...currentPath, { ...node, title: node.name }];
        return true;
      }
      if (node.menuTrees && node.menuTrees.length > 0) {
        if (
          recurse(node.menuTrees, [
            ...currentPath,
            { ...node, title: node.name },
          ])
        ) {
          return true;
        }
      }
    }
    return false;
  }

  recurse(data, []);
  return path;
}

export const useDefaultOpenKeys = (menus, key?: string) => {
  if (typeof window && menus) {
    let keys: { name: string; title: string; id?: string }[] = [];
    const path = findPath(menus, key);
    if (path) {
      keys = [...path];
    }

    return keys;
  } else {
    return [];
  }
};

export const useSearchQuery = (param: {
  key?: string;
  page: number;
  source?: string;
}) => {
  const [dataSource, setDataSource] = useState<any[]>([]);
  const [isAll, setIsAll] = useState(false);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const tmpQry = useRef({});
  const { sharedData } = useSharedData();
  const { envCode } = sharedData;

  useEffect(() => {
    const { key, source, page } = param;
    if (!param.key) {
      setDataSource([]);
      return;
    }
    setIsLoading(true);
    if (
      param.key != tmpQry.current.key ||
      param.source != tmpQry.current.source
    ) {
      setDataSource([]);
    }
    const params = {
      productCode: envCode as string,
      version: Version.V4,
      page,
      size: 20,
      key,
      source,
    };

    getSearch(params)
      .then((res) => {
        if (res.code != 200) return;
        if (
          param.key == tmpQry.current.key &&
          param.source == tmpQry.current.source
        ) {
          if (res.page.page <= res.page.pages) {
            setDataSource([...dataSource, ...res.data]);
          }
        } else {
          setDataSource([...res.data]);
        }
        setTotal(res.page.total);

        const buryParams = {
          keyword: key,
          source: "search",
          answers: res.data?.slice(0, 5)?.map((item) => item.title) ?? [],
          tab: source,
        };
        sendBuryById("0ba013e1-af7f-4f61-a59b-78b3deeca992", buryParams);

        setIsAll(res.page.page == res.page.pages);
        tmpQry.current = { ...param };
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [param]);
  return { dataSource, isAll, isLoading, total };
};
