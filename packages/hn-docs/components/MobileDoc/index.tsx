import { useEffect, useState } from "react";

import XybotEditor from "@/components/XybotEditor/editor";
// import RightContentV2 from "@/components/RightContentV2";
import DocContent from "./components/DocContent";

import { useClientVersion } from "@/hooks";
import { queryDocContent } from "@/api/customer";
import { getDocData } from "@/utils/getDocData";

interface Props {
  id: string;
}

const editPermissions = false;

export default (props: Props) => {
  const { id } = props;
  const [collapseMenu, setCollapseMenu] = useState(false);
  const [docInfo, setDocInfo] = useState({
    content: "",
    contentType: "oss",
    hasDraft: false,
    menuId: "",
    name: "",
  });
  const [initDocJson, setInitDocJson] = useState({});
  const [keywords, setKeywords] = useState("");
  const { version, isLoading } = useClientVersion();

  useEffect(() => {
    getDocInfo();
  }, [id]);

  const getDocInfo = async () => {
    const { data } = await queryDocContent({ menuId: id });
    const contentJson = await getDocData(data.content);

    setDocInfo(data);
    setInitDocJson(contentJson);
  };

  const onCollapse = (e: boolean) => {
    setCollapseMenu(e);
  };

  return (
    <>
      {!isLoading && (
        <>
          <DocContent
            style={{
              paddingLeft: 0,
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
          </DocContent>
        </>
      )}
    </>
  );
};
