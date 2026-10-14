import type { GetServerSideProps } from "next";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";

import RightContent from "@/components/RightContent";
import HtmlHead from "@/components/HtmlHead";
import PcMenu from "@/components/PcMenu";
import RightContentV2 from "@/components/RightContentV2";
import MobileBg from "@/components/MobileBg";
import MobileDoc from "@/components/MobileDoc";
import XybotEditor from "@/components/XybotEditor/editor";

import { usePcMobile, useIsYdBrowser, useClientVersion } from "@/hooks";
import { queryDocContent, queryMenusTrees } from "@/api/customer";
import { queryDoc } from "@/api/admin";
import { RequestSource, type MenuData } from "@/api/index.d";
import { findMenuData } from "@/utils/menu";
import { useSharedData } from "@/context/SharedDataContext";
import { getDocData } from "@/utils/getDocData";
import { useAuthComponents, DOC_COMPONENTS } from "@/hooks/auth";
import { env, ENV_KEYS } from "@/utils/env";

interface Props {
  docContent: any;
  contentJson: any;
}

export default (props: Props) => {
  const { docContent, contentJson } = props;
  const isMobile = usePcMobile();
  const isYd = useIsYdBrowser();
  const [collapseMenu, setCollapseMenu] = useState(false);
  const [docInfo, setDocInfo] = useState(docContent);
  const [initDocJson, setInitDocJson] = useState(contentJson);
  const [keywords, setKeywords] = useState("");
  const { version, isLoading } = useClientVersion();
  const [isMenuId, setIsMenuId] = useState(false);

  const router = useRouter();
  const { from } = router.query;
  // 文档编辑权限管理已移除:编辑入口对所有人放行
  const editPermissions = true;
  // 直接从 router.query 获取 menuId
  const menuId = router.query.menuId as string | undefined;

  const { sharedData } = useSharedData();
  const { id } = sharedData;
  const authComponents = useAuthComponents();

  useEffect(() => {
    setDocInfo(docContent);
    setInitDocJson(contentJson);
  }, [docContent.menuId]);

  useEffect(() => {
    setIsMenuId(!!menuId);
  }, [menuId]);

  useEffect(() => {
    if (id && from === RequestSource.BOSS) {
      getDocInfo();
    }
    if (id && from !== RequestSource.BOSS && env.ENV === "private") {
      getPrivateDocInfo();
    }
  }, [id]);

  const getPrivateDocInfo = async () => {
    const { data } = await queryDocContent({ menuId: id });
    const contentJson = await getDocData(data.content);
    setDocInfo(data);
    setInitDocJson(contentJson);
  };

  const getDocInfo = async () => {
    const { data } = await queryDoc({ id: id as string });
    const contentJson = await getDocData(data.content);
    setDocInfo(data);
    setInitDocJson(contentJson);
  };

  const onCollapse = (e: boolean) => {
    setCollapseMenu(e);
  };

  const onKeyChange = (val: string) => {
    setKeywords(val);
  };

  return (
    <>
      <HtmlHead title={docInfo.name} content={docInfo.seoKey} />
      {!isLoading && (
        <>
          {!isMobile &&
            !version &&
            authComponents.includes(DOC_COMPONENTS.SIDEBAR) && (
              <PcMenu
                style={{
                  width: collapseMenu ? "0" : "330px",
                  top: isYd || version ? "0px" : "81px",
                }}
                onKeyChange={onKeyChange}
              />
            )}
          <>
            <>
              {version ? (
                <MobileBg>
                  {menuId && isMenuId && <MobileDoc id={menuId} />}
                  <RightContentV2
                    style={{
                      display: isMenuId ? "none" : "block",
                      paddingLeft: "0px",
                    }}
                    collapseMenu={collapseMenu}
                    onCollapseMenu={(s) => onCollapse(s)}
                    searchVal={keywords}
                  >
                    {docInfo.menuId && (
                      <XybotEditor
                        docInfo={docInfo}
                        editPermissions={editPermissions}
                        initDocJson={initDocJson}
                      />
                    )}
                  </RightContentV2>
                </MobileBg>
              ) : (
                <>
                  {authComponents.includes(
                    DOC_COMPONENTS.DOC_CONTENT_LAYOUT,
                  ) ? (
                    <RightContent
                      style={{
                        paddingLeft: collapseMenu || isMobile ? "0px" : "330px",
                        paddingTop: isYd || version ? "0px" : "76px",
                      }}
                      collapseMenu={collapseMenu}
                      onCollapseMenu={(s) => onCollapse(s)}
                      searchVal={keywords}
                    >
                      {docInfo.menuId && (
                        <XybotEditor
                          docInfo={docInfo}
                          editPermissions={editPermissions}
                          initDocJson={initDocJson}
                        />
                      )}
                    </RightContent>
                  ) : (
                    <XybotEditor
                      docInfo={docInfo}
                      editPermissions={editPermissions}
                      initDocJson={initDocJson}
                    />
                  )}
                </>
              )}
            </>
          </>
        </>
      )}
    </>
  );
};

export const getServerSideProps: GetServerSideProps = async (context) => {
  const { from, brandCode, param, languageCode } = context.query;
  const [id] = Array.isArray(param) ? param : [];

  // 管理端不走服务端渲染
  // 使用 ENV_KEYS 常量避免 Next.js 构建时静态替换
  if (
    from === RequestSource.BOSS ||
    process.env[ENV_KEYS.NEXT_PUBLIC_ENV] === "private"
  ) {
    return {
      props: {
        docContent: {},
      },
    };
  } else {
    let menuData = {} as MenuData | null;
    const result = await queryMenusTrees({
      brandCode: brandCode as string,
      languageCode: languageCode as string,
    });

    if (result.code === 200) {
      menuData = findMenuData(result.data, id as string);
    }
    let content = {
      content: "",
    };
    if (menuData?.id) {
      const { data } = await queryDocContent({ menuId: menuData.id });
      content = data;
    }
    const contentJson = await getDocData(content?.content);
    return {
      props: {
        docContent: content,
        contentJson,
      },
    };
  }
};
