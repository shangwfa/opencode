import Head from "next/head";
import { useEffect, useState } from "react";

import { queryOemInfo } from "@/api/customer";
import { getLang } from "@/utils/getLang";
import { useSharedData } from "@/context/SharedDataContext";
import { env } from "@/utils/env";

interface IHtmlHeadProps {
  title?: string;
  content?: string;
}

export default (props: IHtmlHeadProps) => {
  const { title, content } = props;
  const text = getLang("yd_help_center");
  const privateText = getLang("help_center");
  const [oem, setOem] = useState({
    name: "",
    iconUrl: "",
  });

  const { sharedData } = useSharedData();
  const { oemInfo } = sharedData;

  useEffect(() => {
    if (env.ENV === "private") {
      queryOem();
    }
  }, []);

  const queryOem = () => {
    queryOemInfo().then((res) => {
      if (res.code === 200 && res.data) {
        setOem({
          name: res.data?.oem?.productName,
          iconUrl: res.data?.oem?.logo,
        });
      }
    });
  };

  return (
    <Head>
      {env.ENV === "private" ? (
        <title>{`${title ? title + " - " : ""}${oem.name || privateText}`}</title>
      ) : (
        <title>{`${title ? title + " - " : ""}${oemInfo.title || text}`}</title>
      )}

      {env.ENV === "private" && oem.iconUrl ? (
        <link rel="icon" href={oem.iconUrl} />
      ) : (
        <link rel="icon" href={`${env.BASE_PATH}/favicon.ico`} />
      )}
      <meta
        property={`og:title`}
        content={content || title || text}
        key={title || text}
      />
    </Head>
  );
};
