import React, { useEffect, useRef, useState } from "react";
import { message, Tree, Tooltip } from "antd";
import type { GetProps, TreeDataNode, TreeProps } from "antd";
import { useRouter } from "next/router";
import { EyeInvisibleOutlined } from "@ant-design/icons";

import DropdownMenu from "./components/DropdownMenu";
import QuickStart from "./components/QuickStart";

import { queryMenusTrees } from "@/api/customer";
import { getAdminMenuTree, tuneUpOrder } from "@/api/admin";
import { RequestSource, MenuItemType } from "@/api/index.d";
import { useDefaultOpenKeys, usePcMobile } from "@/hooks";
import { findMenuData, generateMenuData } from "@/utils/menu";
import { useSharedData } from "@/context/SharedDataContext";
import { resourceDomain } from "@/utils/resources";
import { getUrlParams } from "@/utils";
import { env } from "@/utils/env";

import RightIcon from "/static/img/right.svg";

import type { ResBasic, MenuData } from "@/api/index.d";

import "./index.css";

interface TreeNode extends TreeDataNode, MenuData {}
type DirectoryTreeProps = GetProps<typeof Tree.DirectoryTree>;
interface TreePropsNode extends TreeProps {
  dragNode: {
    id: string;
    type: MenuItemType;
  };
  node: {
    parentId: string;
    type: MenuItemType;
    id: string;
  };
  dropToGap: boolean;
  dropPosition: number;
}

const { DirectoryTree } = Tree;

const fieldNames = {
  title: "name",
  key: "id",
  children: "menuTrees",
  icon: "iconUrl",
};

export default (props) => {
  const [menuData, setMenuData] = useState([] as TreeNode[]);
  const [expandedKeys, setExpandedKeys] = useState<(string | undefined)[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [permissions, setPermissions] = useState<boolean>(false);
  const initStatus = useRef(true);
  const isMobile = usePcMobile();
  const router = useRouter();
  const { updateSharedData, sharedData } = useSharedData();
  const { docEnvConfigReference } = sharedData;

  const { brandCode, from, param, languageCode } = router.query;
  const [id] = Array.isArray(param) ? param : [];
  const menuParamId = getUrlParams("id");
  // 文档编辑权限管理已移除:详情入口与操作权限对所有人放行
  const showDetailEntryOrFull = true;

  useEffect(() => {
    getMenuData();
  }, [brandCode]);

  const getMenuData = async (menuId?: string) => {
    const code = brandCode?.toString();
    if (!code || !languageCode) return;
    const currentSelectedId = menuId || (id as string) || menuParamId;
    let result: ResBasic<TreeNode[]>;
    if (from === RequestSource.BOSS) {
      setPermissions(true);
      result = await getAdminMenuTree({
        brandCode: code,
        languageCode: languageCode as string,
      });
    } else {
      result = await queryMenusTrees({
        brandCode: code,
        languageCode: languageCode as string,
      });
    }
    if (result.code === 200) {
      const domain = await resourceDomain();
      const menu = generateMenuData(result.data, domain);
      setMenuData(menu);

      // 没有id不做菜单选中及校验
      if (currentSelectedId) {
        const selectedMenu = findMenuData(result.data, currentSelectedId);
        if (selectedMenu) {
          updateSharedData({
            id: selectedMenu.id,
            brandCode: brandCode as string,
            languageCode: languageCode as string,
            menus: result.data,
            docUniqueId: selectedMenu.docUniqueId,
          });

          const keys = useDefaultOpenKeys(result.data, selectedMenu.id).map(
            (item) => item.id
          );
          //初始化及新增路径需要展开对应文件夹
          (initStatus.current || menuId) && setExpandedKeys(keys);
          // 特殊处理，如果选中的是文件夹，则只展示当前文件夹下的文档
          if (selectedMenu.type === MenuItemType.FOLDER) {
            setTimeout(() => {
              const scrollEle = document.querySelector(
                "#mobile-container"
              ) as HTMLElement;
              const ele = document.querySelector(
                ".ant-tree-treenode-selected"
              ) as HTMLElement;
              const elementTop = ele.offsetTop + scrollEle.offsetTop;

              // 使用 window.scrollTo 滚动到目标位置，减去偏移量
              scrollEle.scrollTo({ top: elementTop - 80, behavior: "smooth" });
            }, 300);
          }
          setSelectedKeys([selectedMenu.id]);
        } else {
          initStatus.current && setExpandedKeys([]);
          setSelectedKeys([]);

          updateSharedData({
            id: "",
            brandCode: brandCode as string,
            languageCode: languageCode as string,
            menus: result.data,
            docUniqueId: "",
          });
        }
        initStatus.current = false;
      } else {
        updateSharedData({
          id: "",
          brandCode: brandCode as string,
          languageCode: languageCode as string,
          menus: result.data,
          docUniqueId: "",
        });
      }
    }
  };

  const onSelect: DirectoryTreeProps["onSelect"] = (
    keys: string[],
    info: any
  ) => {
    // 仅支持点击到文档切换路径
    if (info.node.type === MenuItemType.DOC) {
      // 有自定义路径
      // router.push(
      //   from
      //     ? `/${productCode}/${info.node.slug || keys[0]}?from=${from}`
      //     : `/${productCode}/${info.node.slug || keys[0]}`
      // );

      router.push(
        from
          ? `/${brandCode}/${languageCode}/${info.node.docUniqueId}?from=${from}`
          : `/${brandCode}/${languageCode}/${info.node.docUniqueId}`
      );

      setSelectedKeys(keys);
      updateSharedData({
        id: info.node.id,
        brandCode: brandCode as string,
        languageCode: languageCode as string,
        menus: menuData,
        docUniqueId: info.node.docUniqueId,
      });
    }
  };

  const onExpand: DirectoryTreeProps["onExpand"] = (keys: string[]) => {
    setExpandedKeys(keys);
  };

  const onDragEnter: TreeProps["onDragEnter"] = (info: any) => {
    setExpandedKeys(info.expandedKeys);
  };

  const onDrop = (info: any) => {
    console.log(info);
    let params = {
      id: info.dragNode.id,
      targetPreviousId: "",
      targetParentId: "",
    };

    // 与插入前节点为平级关系
    if (info.dropToGap) {
      params = {
        ...params,
        targetPreviousId: info.dropPosition === -1 ? "0" : info.node.id,
        targetParentId: info.node.parentId,
      };
    } else {
      // 与插入前节点为父子关系
      if (
        info.dragNode.type === MenuItemType.FOLDER &&
        info.node.type === MenuItemType.DOC
      ) {
        message.error("文档下不支持存放文件夹");
        return;
      }
      if (
        info.dragNode.type === MenuItemType.DOC &&
        info.node.type === MenuItemType.DOC
      ) {
        message.error("文档下不支持存放文档");
        return;
      }
      params = {
        ...params,
        targetPreviousId: "0",
        targetParentId: info.node.id,
      };
    }

    tuneUpOrder(params).then((res) => {
      if (res.code === 200) {
        message.success("操作成功");
        getMenuData();
      }
    });
  };
  // todo: 默认展开所有菜单，短暂支持rpa数据同步使用，后期需要下掉
  const flattenTree = (data: MenuData[]) => {
    let result: string[] = [];

    function traverse(node: MenuData) {
      if (node.id) {
        result.push(node.id);
      }
      if (node.menuTrees && node.menuTrees.length > 0) {
        node.menuTrees.forEach((child) => traverse(child));
      }
    }

    data.forEach((item) => traverse(item));
    return result;
  };

  return (
    <>
      {!isMobile && env.ENV !== "private" && (
        <QuickStart
          brandCode={brandCode as string}
          languageCode={languageCode as string}
          onUpdateMenu={(menuId?: string) => getMenuData(menuId)}
          permissions={permissions}
        />
      )}
      <DirectoryTree
        switcherIcon={(data) => {
          return (
            <RightIcon
              style={{
                transform: `rotate(${data.expanded ? "90deg" : 0})`,
              }}
            />
          );
        }}
        expandedKeys={expandedKeys as string[]}
        selectedKeys={selectedKeys}
        onSelect={onSelect}
        onExpand={onExpand}
        className="draggable-tree"
        draggable={
          from === RequestSource.BOSS && docEnvConfigReference
            ? { icon: false }
            : false
        }
        blockNode
        onDragEnter={onDragEnter}
        onDrop={onDrop}
        treeData={menuData}
        showIcon={from === RequestSource.BOSS ? true : false}
        fieldNames={fieldNames}
        titleRender={(nodeData: TreeNode) => {
          const {
            name,
            iconUrl,
            scope,
            type,
          }: {
            name: string;
            iconUrl: string;
            scope: string;
            type: MenuItemType;
          } = nodeData;
          return showDetailEntryOrFull ? (
            <span className="flex justify-between items-center">
              <span className="flex items-center overflow-hidden flex-1">
                {iconUrl && (
                  <img
                    src={iconUrl}
                    alt=""
                    className="mr-[4px] w-[16px] h-[16px]"
                  />
                )}
                <span className="w-full overflow-hidden whitespace-nowrap overflow-ellipsis">
                  {name}
                </span>
              </span>
              {(env.ENV !== "private" ||
                (env.ENV === "private" &&
                  scope === "private_custom")) && (
                <>
                  {!nodeData.enable && (
                    <Tooltip
                      placement="top"
                      title={`当前${type === MenuItemType.FOLDER ? "分组" : "文档"}在用户端不可见`}
                    >
                      <EyeInvisibleOutlined className="mr-[4px]" />
                    </Tooltip>
                  )}

                  <span
                    className="cursor-pointer flex items-center justify-center w-[24px] h-[24px] text-base text-primary transition duration-350 ease-in-out rounded-lg hover:bg-gray-300"
                    onClick={(e) => e.stopPropagation()}
                    data-bury-id="7e286356-15c1-4e66-894b-4d9072d0e437"
                  >
                    <DropdownMenu
                      nodeData={nodeData}
                      languageCode={languageCode as string}
                      brandCode={brandCode as string}
                      onUpdateMenu={(menuId?: string) => getMenuData(menuId)}
                      canEditFull={true}
                      canEditLimited={true}
                      canDelete={true}
                    />
                  </span>
                </>
              )}
            </span>
          ) : (
            <span className="flex justify-between items-center pt-[2px]">
              {iconUrl && (
                <img
                  src={iconUrl}
                  alt=""
                  className="mr-[4px] w-[16px] h-[16px]"
                />
              )}
              <span className="block w-full overflow-hidden whitespace-nowrap overflow-ellipsis">
                {name}
              </span>
            </span>
          );
        }}
      />
    </>
  );
};
