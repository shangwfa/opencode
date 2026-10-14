import { useEffect, useRef } from "react";

interface UseIframeHeightOptions {
  /** 额外的高度缓冲区，默认为 60px */
  bufferHeight?: number;
  /** 图片加载超时时间，默认为 5000ms */
  imageTimeout?: number;
  /** 最终发送高度前的延迟时间，默认为 300ms */
  sendDelay?: number;
  /** 检测动态图片的延迟时间，默认为 100ms */
  detectDelay?: number;
}

/**
 * 用于管理 iframe 高度的自定义 hook
 * 会在页面完全加载（包括所有图片）后发送 postMessage 通知父页面调整 iframe 高度
 */
export const useIframeHeight = (options: UseIframeHeightOptions = {}) => {
  const {
    bufferHeight = 60,
    imageTimeout = 5000,
    sendDelay = 200,
    detectDelay = 100,
  } = options;

  const currentHeight = useRef(0);

  const sendPostMessage = (height?: number) => {
    // 检查是否在 iframe 中
    if (window.parent === window) return;

    const actualHeight = height || document.body.scrollHeight;
    const adjustedHeight = actualHeight + bufferHeight;

    window.parent.postMessage(
      {
        type: "SET_IFRAME_HEIGHT",
        height: `${adjustedHeight}px`,
      },
      "*"
    );
  };

  useEffect(() => {
    // 如果不在 iframe 中，直接返回
    if (window.parent === window) return;

    let hasBasicLoadCompleted = false;
    let hasImagesLoaded = false;

    const checkAndSendHeight = () => {
      // 只有基础加载和图片都完成后才发送高度
      if (hasBasicLoadCompleted && hasImagesLoaded) {
        setTimeout(() => {
          const height = document.body.scrollHeight;
          currentHeight.current = height;
          sendPostMessage(height);
        }, sendDelay);
      }
    };

    // 等待所有图片加载完成的函数
    const waitForImages = () => {
      const images = document.querySelectorAll("img");
      let loadedImages = 0;
      const totalImages = images.length;

      if (totalImages === 0) {
        hasImagesLoaded = true;
        checkAndSendHeight();
        return;
      }

      const handleImageLoad = () => {
        loadedImages++;
        if (loadedImages === totalImages) {
          hasImagesLoaded = true;
          checkAndSendHeight();
        }
      };

      images.forEach((img) => {
        if (img.complete && img.naturalHeight !== 0) {
          // 图片已经加载完成且有效
          handleImageLoad();
        } else {
          img.addEventListener("load", handleImageLoad);
          img.addEventListener("error", handleImageLoad); // 处理加载失败的情况
        }
      });

      // 设置超时，避免某些图片永远不加载导致卡死
      setTimeout(() => {
        if (!hasImagesLoaded) {
          hasImagesLoaded = true;
          checkAndSendHeight();
        }
      }, imageTimeout);
    };

    const handleBasicLoad = () => {
      hasBasicLoadCompleted = true;

      // 等待一个短暂的时间让动态添加的图片有机会被检测到
      setTimeout(() => {
        waitForImages();
      }, detectDelay);
    };

    // 监听页面基础加载完成
    if (document.readyState === "complete") {
      // 如果已经加载完成，直接处理
      handleBasicLoad();
    } else {
      // 等待 load 事件（所有资源包括CSS、JS等加载完成）
      window.addEventListener("load", handleBasicLoad);
    }

    return () => {
      window.removeEventListener("load", handleBasicLoad);
    };
  }, [bufferHeight, imageTimeout, sendDelay, detectDelay]);

  return {
    sendPostMessage,
    currentHeight: currentHeight.current,
  };
};
