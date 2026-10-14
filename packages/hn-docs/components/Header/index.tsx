"use client";

import { useRouter } from "next/router";
import React, { useEffect, useState, useCallback } from "react";
import Image from "next/image"; // 导入 Image 组件
import { Row } from "antd";

import { queryOemInfo, queryDocEnvConfig } from "@/api/customer";
import { usePcMobile } from "@/hooks";
import { resourceDomain } from "@/utils/resources";
import { useJumpUrl } from "@/hooks/jump-url";
import { env } from "@/utils/env";

import { useSharedData } from "@/context/SharedDataContext";

import LogoIcon from "/static/icon/logo.png";
import enLogo from "/static/icon/enLogo.png";
import { getLang } from "@/utils/getLang";

interface LogoProps {
  oem: { name: string; iconUrl: string } | null;
}

const Logo = ({ oem }: LogoProps) => {
  const [domain, setDomain] = useState<string>("");

  const fetchDomain = useCallback(async () => {
    const domainRes = await resourceDomain();
    if (domainRes !== domain) {
      setDomain(domainRes);
    }
  }, [domain]);

  useEffect(() => {
    if (oem?.iconUrl) {
      fetchDomain();
    }
  }, [oem?.iconUrl, fetchDomain]);

  const iconUrl = oem?.iconUrl?.includes("http")
    ? oem.iconUrl
    : domain + oem?.iconUrl;

  return (
    <Row className="mr-[20px]" align="middle">
      {oem?.iconUrl ? (
        domain && <img src={iconUrl} className="h-[32px]" alt="logo" />
      ) : env.ENV === "international" ? (
        <Image src={enLogo} className="h-[32px] mr-[24px]" alt="logo" />
      ) : (
        <Image src={LogoIcon} className="h-[32px] w-auto" alt="logo" />
      )}
    </Row>
  );
};
const LogoBanner = (props) => {
  const [oem, setOem] = useState<{ name: string; iconUrl: string } | null>(
    null,
  );
  const [loading, setLoading] = useState<boolean>(false);
  const isMobile = usePcMobile();
  const jumpUrl = useJumpUrl();
  const router = useRouter();

  const { brandCode, languageCode } = router.query;

  useEffect(() => {
    if (env.ENV === "private") {
      queryOem();
    } else if (brandCode) {
      getProductInfo();
    }
  }, [brandCode]);

  const queryOem = () => {
    setLoading(false);
    queryOemInfo().then((res) => {
      if (res.code === 200 && res.data) {
        setOem({
          name: res.data?.oem?.productName,
          iconUrl: res.data?.oem?.logo,
        });
        setLoading(true);
      } else {
        getProductInfo();
      }
    });
  };

  const getProductInfo = () => {
    if (!brandCode) return;
    queryDocEnvConfig({
      brandCode: brandCode as string,
      languageCode: languageCode as string,
    })
      .then((res) => {
        if (res.code === 200) {
          const { docEnvConfigExtraInfo } = res.data;
          if (docEnvConfigExtraInfo) {
            const extraInfo = JSON.parse(docEnvConfigExtraInfo);
            setOem({
              name: extraInfo.title,
              iconUrl: extraInfo.logo,
            });
          }
        }
        // else if (res.code === 10001) {
        //   // 产品不存在code码跳转到rpa
        //   router.push("/rpa");
        // }
        else {
          setOem(null);
        }
      })
      .catch(() => {
        console.error("Failed to fetch product info");
        setOem(null);
      })
      .finally(() => {
        setLoading(true);
      });
  };

  return (
    <div>
      {loading && (
        <div
          className={`fixed top-0 left-0 z-[2] flex w-full items-center bg-white border-b border-[#efefef] ${isMobile && "justify-center"}`}
        >
          <a
            href={jumpUrl()}
            className={`flex items-center py-[24px] px-[32px] ${isMobile && "py-[14px] px-0"}`}
          >
            <Logo oem={oem} />
            <div className="w-[2px] h-[20px] mr-[20px] bg-[#757c8f] scale-x-50"></div>
            <div
              className="text-[#192544] font-normal text-[18px] font-[PingFangSC-Regular]"
              translate="no"
            >
              {oem?.name || getLang("help_center")}
            </div>
          </a>
        </div>
      )}
    </div>
  );
};

export default LogoBanner;
