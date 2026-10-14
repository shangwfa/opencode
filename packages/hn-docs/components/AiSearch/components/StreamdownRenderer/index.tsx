import React, { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
// @ts-ignore - rehype-raw types may not be available immediately after install
import rehypeRaw from "rehype-raw";
import { Image } from "antd";

import "./index.css";

interface Props {
  value: string;
  isRunning: boolean;
  isStop: boolean;
  toolCallingStatus?: string | null;
  errorMessage?: string | null;
  onRendered: () => void;
}

const StreamdownRenderer = (props: Props) => {
  const {
    value,
    isRunning,
    isStop,
    toolCallingStatus = null,
    errorMessage = null,
    onRendered,
  } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const timer = useRef<any>(null);
  const [showCursor, setShowCursor] = useState(false);
  const isStopRef = useRef(isStop); // 使用 ref 跟踪 isStop 状态
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewImage, setPreviewImage] = useState("");
  const previewVisibleRef = useRef(false);
  const previewImageRef = useRef("");

  // 更新 isStop ref
  useEffect(() => {
    isStopRef.current = isStop;
  }, [isStop]);

  // 清理函数执行锁，防止并发执行
  const cleanupLockRef = useRef(false);

  // 通用的清理函数：删除容器中所有只包含占位符字符（下划线、连字符等）的文本节点
  const removeTrailingUnderscores = (container: HTMLElement) => {
    if (!container) {
      return;
    }

    // 如果正在执行清理，跳过本次执行
    if (cleanupLockRef.current) {
      return;
    }

    // 设置执行锁
    cleanupLockRef.current = true;

    try {
      // 递归查找所有文本节点
      const walker = document.createTreeWalker(
        container,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            // 跳过光标节点内的文本
            if (
              node.parentElement?.classList?.contains("typing-cursor") ||
              node.parentElement?.closest(".typing-cursor")
            ) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        },
      );

      const textNodesToRemove: Text[] = [];

      let node;
      while ((node = walker.nextNode())) {
        const textNode = node as Text;
        const text = textNode.textContent || "";

        // 检查文本节点是否只包含占位符字符（下划线、连字符等）或空白字符
        // 匹配模式：只包含占位符字符和空白字符（空格、换行、制表符等）
        const trimmed = text.trim();

        // 检查是否只包含下划线、连字符或其他常见的占位符字符
        // 匹配：纯下划线、纯连字符、或只包含这些字符和空白字符的组合
        if (
          trimmed === "_" ||
          trimmed === "-" ||
          trimmed === "—" || // em dash
          trimmed === "–" || // en dash
          /^[\s_-]+$/.test(text) || // 只包含空白、下划线、连字符
          (trimmed === "" && /[_-]/.test(text)) // 空白中包含下划线或连字符
        ) {
          textNodesToRemove.push(textNode);
        } else {
          // 检查文本节点末尾是否只包含占位符字符（前面可能有空白）
          // 例如："安装。 -" 或 "安装。_" 这种情况
          // 如果末尾是占位符且前面只有空白，则标记为删除（而不是修改）
          const trailingPlaceholderMatch = text.match(/[\s]*([_-])[\s]*$/);
          if (trailingPlaceholderMatch) {
            // 检查占位符前面是否只有空白字符（没有实际内容）
            const beforePlaceholder = text.slice(
              0,
              trailingPlaceholderMatch.index || 0,
            );
            if (/^[\s]*$/.test(beforePlaceholder)) {
              // 如果前面只有空白，整个节点都是占位符，标记为删除
              textNodesToRemove.push(textNode);
            } else {
              // 如果前面有内容，尝试安全地修改文本内容
              try {
                const newText = text.replace(/[\s]*[_-][\s]*$/, "");
                if (newText !== text && textNode.parentNode) {
                  // 验证节点仍然在 DOM 中
                  if (textNode.parentNode.contains(textNode)) {
                    textNode.textContent = newText;
                  }
                }
              } catch (e) {
                // 如果修改失败，静默忽略（节点可能已被其他操作修改）
              }
            }
          }
        }
      }

      // 清空匹配的文本节点内容（而不是删除节点，更安全）
      // 这样可以完全避免 removeChild 错误
      for (let i = textNodesToRemove.length - 1; i >= 0; i--) {
        const textNode = textNodesToRemove[i];
        if (!textNode) {
          continue; // 跳过 undefined 节点
        }

        try {
          // 检查节点是否仍然在 DOM 中
          if (!container.contains(textNode)) {
            continue; // 节点不在容器中，跳过
          }

          // 检查节点是否仍然有父节点
          if (!textNode.parentNode) {
            continue; // 节点已经被移除，跳过
          }

          // 验证节点仍然在父节点中
          if (!textNode.parentNode.contains(textNode)) {
            continue; // 节点不在父节点中，跳过
          }

          // 不删除节点，而是清空文本内容（更安全，避免 removeChild 错误）
          // 清空内容后，节点仍然存在但不可见，不会影响布局
          textNode.textContent = "";
        } catch (e) {
          // 静默忽略错误，避免影响正常渲染
          // 节点可能已经被其他操作移除了
        }
      }
    } finally {
      // 释放执行锁
      cleanupLockRef.current = false;
    }
  };

  useEffect(() => {
    // 如果已停止，延迟隐藏光标
    if (isStop) {
      timer.current = setTimeout(() => {
        setShowCursor(false);
      }, 500);
      return () => {
        clearTimeout(timer.current);
      };
    }

    // 在生成过程中（未停止），始终显示光标
    // 只要未停止，不管 isRunning 和 value 的状态，都应该显示光标
    if (!isStop) {
      setShowCursor(true);
    }

    return () => {
      clearTimeout(timer.current);
    };
  }, [isStop]);

  // 专门监听 isStop 变化，在流式停止时清理尾部的下划线
  useEffect(() => {
    if (!isStop) {
      return;
    }

    // 延迟执行，确保 DOM 完全渲染后再清除
    const timeoutId = setTimeout(() => {
      if (!containerRef.current) {
        return;
      }

      const container = containerRef.current.querySelector(
        ".streamdown-container",
      ) as HTMLElement;
      if (!container) {
        return;
      }

      // 使用通用的清理函数删除所有尾部的下划线
      // 使用 requestAnimationFrame 确保在合适的时机执行
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          removeTrailingUnderscores(container);
        });
      });
    }, 100); // 延迟 100ms 确保 DOM 完全渲染

    return () => {
      clearTimeout(timeoutId);
    };
  }, [isStop]);

  useEffect(() => {
    if (value) {
      // 使用 setTimeout 确保 DOM 已更新
      setTimeout(() => {
        onRendered();
      }, 0);
    }
  }, [value, onRendered]);

  // 监听 value 变化，清理尾部的下划线
  useEffect(() => {
    if (!value || !containerRef.current) {
      return;
    }

    // 延迟执行，确保 Streamdown 完全渲染
    const timeoutId = setTimeout(() => {
      const container = containerRef.current?.querySelector(
        ".streamdown-container",
      ) as HTMLElement;
      if (container) {
        // 使用 requestAnimationFrame 确保在合适的时机执行
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            removeTrailingUnderscores(container);
          });
        });
      }
    }, 100);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [value]);

  // 更新预览相关的 ref
  useEffect(() => {
    previewVisibleRef.current = previewVisible;
    previewImageRef.current = previewImage;
  }, [previewVisible, previewImage]);

  // 为图片添加点击预览功能 - 直接在图片上绑定事件
  useEffect(() => {
    if (!containerRef.current || !value) {
      return;
    }

    const rootContainer = containerRef.current;
    const imageClickHandlers: Map<HTMLImageElement, (e: MouseEvent) => void> =
      new Map();

    // 处理图片点击事件
    const handleImageClick = (e: Event, img: HTMLImageElement) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const imageSrc = img.src || img.getAttribute("src") || img.currentSrc;
      if (imageSrc) {
        setPreviewImage(imageSrc);
        setPreviewVisible(true);
      }
      return false;
    };

    // 为图片添加点击事件监听器
    const addImageClickListeners = () => {
      const container = rootContainer.querySelector(
        ".streamdown-container",
      ) as HTMLElement;
      if (!container) {
        return;
      }

      const images = container.querySelectorAll("img");

      images.forEach((img, index) => {
        // 清理旧的事件监听器
        const existingHandler = imageClickHandlers.get(img);
        if (existingHandler) {
          img.removeEventListener("click", existingHandler);
        }

        // 添加样式
        img.style.cursor = "pointer";
        img.style.userSelect = "none";
        img.style.pointerEvents = "auto";

        // 处理图片包装器中的覆盖层 div，确保它们不阻止点击
        const imageWrapper = img.closest(
          '[data-streamdown="image-wrapper"]',
        ) as HTMLElement;
        if (imageWrapper) {
          // 找到覆盖层 div 并确保它不阻止点击
          const overlayDivs = imageWrapper.querySelectorAll(
            'div[class*="pointer-events-none"], div.absolute.inset-0',
          );
          overlayDivs.forEach((overlay) => {
            (overlay as HTMLElement).style.pointerEvents = "none";
          });

          // 确保图片本身可以接收点击
          imageWrapper.style.cursor = "pointer";
        }

        // 检查图片是否被链接包裹
        const parentLink = img.closest("a");
        if (parentLink) {
          parentLink.style.cursor = "pointer";
        }

        // 创建事件处理函数 - 使用捕获阶段
        const captureHandler = (e: Event) => {
          handleImageClick(e, img);
        };

        // 创建事件处理函数 - 使用冒泡阶段
        const bubbleHandler = (e: Event) => {
          handleImageClick(e, img);
        };

        // 绑定捕获阶段的事件（优先级更高）
        img.addEventListener("click", captureHandler, true);
        // 绑定冒泡阶段的事件
        img.addEventListener("click", bubbleHandler, false);

        // 如果图片在包装器中，也在包装器上绑定事件（处理覆盖层点击）
        if (imageWrapper) {
          const wrapperHandler = (e: Event) => {
            // 如果点击的不是按钮，则触发图片预览
            const target = e.target as HTMLElement;
            if (!target.closest('button[type="button"]')) {
              handleImageClick(e, img);
            }
          };
          imageWrapper.addEventListener("click", wrapperHandler, true);
          // 将包装器处理器存储起来
          (imageWrapper as any).__imagePreviewHandler = wrapperHandler;
        }

        // 如果图片被链接包裹，也在链接上绑定捕获事件
        if (parentLink) {
          const linkHandler = (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            handleImageClick(e, img);
            return false;
          };
          parentLink.addEventListener("click", linkHandler, true);
          // 将链接处理器也存储起来，但用特殊标记
          (parentLink as any).__imagePreviewHandler = linkHandler;
        }

        imageClickHandlers.set(img, captureHandler);
      });
    };

    let observer: MutationObserver | null = null;

    // 初始化和绑定事件
    const initStylesAndBindEvent = () => {
      const container = rootContainer.querySelector(
        ".streamdown-container",
      ) as HTMLElement;
      if (!container) {
        return false;
      }

      // 清理旧的事件监听器
      imageClickHandlers.forEach((handler, img) => {
        img.removeEventListener("click", handler, true);
        img.removeEventListener("click", handler, false);

        // 清理包装器上的处理器
        const imageWrapper = img.closest(
          '[data-streamdown="image-wrapper"]',
        ) as HTMLElement;
        if (imageWrapper && (imageWrapper as any).__imagePreviewHandler) {
          imageWrapper.removeEventListener(
            "click",
            (imageWrapper as any).__imagePreviewHandler,
            true,
          );
          delete (imageWrapper as any).__imagePreviewHandler;
        }

        // 清理链接上的处理器
        const parentLink = img.closest("a");
        if (parentLink && (parentLink as any).__imagePreviewHandler) {
          parentLink.removeEventListener(
            "click",
            (parentLink as any).__imagePreviewHandler,
            true,
          );
          delete (parentLink as any).__imagePreviewHandler;
        }
      });
      imageClickHandlers.clear();

      // 添加事件监听器
      addImageClickListeners();

      // 使用 MutationObserver 监听 DOM 变化，为新增的图片添加事件
      if (observer) {
        observer.disconnect();
      }
      observer = new MutationObserver(() => {
        addImageClickListeners();
      });

      observer.observe(container, {
        childList: true,
        subtree: true,
      });

      return true;
    };

    // 延迟初始化，确保 DOM 完全渲染
    let retryCount = 0;
    const maxRetries = 10;

    const tryInit = () => {
      if (initStylesAndBindEvent()) {
        return;
      }

      retryCount++;
      if (retryCount < maxRetries) {
        setTimeout(tryInit, 200);
      } else {
        console.log("[ImagePreview] 初始化失败，已达到最大重试次数");
      }
    };

    const timeoutId = setTimeout(tryInit, 200);

    return () => {
      clearTimeout(timeoutId);
      if (observer) {
        observer.disconnect();
      }
      // 清理所有图片的事件监听器
      imageClickHandlers.forEach((handler, img) => {
        img.removeEventListener("click", handler, true);
        img.removeEventListener("click", handler, false);

        // 清理包装器上的处理器
        const imageWrapper = img.closest(
          '[data-streamdown="image-wrapper"]',
        ) as HTMLElement;
        if (imageWrapper && (imageWrapper as any).__imagePreviewHandler) {
          imageWrapper.removeEventListener(
            "click",
            (imageWrapper as any).__imagePreviewHandler,
            true,
          );
          delete (imageWrapper as any).__imagePreviewHandler;
        }

        // 清理链接上的处理器
        const parentLink = img.closest("a");
        if (parentLink && (parentLink as any).__imagePreviewHandler) {
          parentLink.removeEventListener(
            "click",
            (parentLink as any).__imagePreviewHandler,
            true,
          );
          delete (parentLink as any).__imagePreviewHandler;
        }
      });
      imageClickHandlers.clear();
    };
  }, [value]);

  // 使用 CSS 类来控制光标的显示
  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const container = containerRef.current.querySelector(
      ".streamdown-container",
    ) as HTMLElement;
    if (!container) {
      return;
    }

    // 清理光标函数
    const removeCursor = () => {
      const oldCursor = container.querySelector(".typing-cursor");
      if (oldCursor) {
        try {
          if (typeof (oldCursor as any).remove === "function") {
            (oldCursor as any).remove();
          } else {
            (oldCursor as HTMLElement).style.display = "none";
          }
        } catch (e) {
          // 静默忽略错误
        }
      }
      container.classList.remove("has-cursor");
    };

    // 如果已停止，立即清除光标
    if (isStop) {
      removeCursor();
      return;
    }

    // 添加或移除光标类
    if (showCursor && !isStop) {
      container.classList.add("has-cursor");
    } else {
      container.classList.remove("has-cursor");
      removeCursor();
    }

    // 如果没有内容，直接返回
    if (!value) {
      return;
    }

    // 改进的 getLastTextNode：找到真正的最后一个有内容的文本节点
    const getLastTextNode = (node: Node): Node | null => {
      if (node.nodeType === Node.TEXT_NODE) {
        // 排除只包含空白字符的文本节点
        const textContent = node.textContent?.trim();
        if (textContent && textContent.length > 0) {
          return node;
        }
        return null;
      }

      const children = node.childNodes;
      // 从后往前遍历，找到最后一个有内容的文本节点
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i];
        if (!child) continue;

        // 跳过注释节点和脚本节点
        if (
          child.nodeType === Node.COMMENT_NODE ||
          (child.nodeType === Node.ELEMENT_NODE &&
            ((child as Element).tagName === "SCRIPT" ||
              (child as Element).tagName === "STYLE"))
        ) {
          continue;
        }

        // 跳过已经插入的光标节点
        if (
          child.nodeType === Node.ELEMENT_NODE &&
          (child as Element).classList?.contains("typing-cursor")
        ) {
          continue;
        }

        const result = getLastTextNode(child);
        if (result) {
          return result;
        }
      }
      return null;
    };

    // 获取最后一个可见元素（作为后备方案）
    const getLastVisibleElement = (node: Node): Node | null => {
      if (node.nodeType === Node.TEXT_NODE) {
        return node;
      }

      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as HTMLElement;
        // 跳过隐藏元素
        if (
          element.style.display === "none" ||
          element.style.visibility === "hidden" ||
          element.offsetHeight === 0
        ) {
          return null;
        }
      }

      const children = node.childNodes;
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i];
        if (!child) continue;

        if (child.nodeType === Node.COMMENT_NODE) continue;

        // 跳过光标节点
        if (
          child.nodeType === Node.ELEMENT_NODE &&
          (child as Element).classList?.contains("typing-cursor")
        ) {
          continue;
        }

        const result = getLastVisibleElement(child);
        if (result) {
          return result;
        }
      }

      // 如果没有子节点，返回当前节点
      if (node.nodeType === Node.ELEMENT_NODE && children.length === 0) {
        return node;
      }

      return null;
    };

    const updateCursorPosition = () => {
      // 使用 ref 检查最新的 isStop 状态
      if (!showCursor || isStopRef.current || !container) {
        // 如果已停止，确保光标被清除
        if (isStopRef.current) {
          removeCursor();
        }
        return;
      }

      // 移除旧的光标标记
      const oldCursor = container.querySelector(".typing-cursor");
      if (oldCursor) {
        try {
          if (typeof (oldCursor as any).remove === "function") {
            (oldCursor as any).remove();
          } else {
            (oldCursor as HTMLElement).style.display = "none";
          }
        } catch (e) {
          // 静默忽略错误
        }
      }

      // 找到最后一个文本节点
      let lastTextNode = getLastTextNode(container);

      // 如果找不到文本节点，使用后备方案
      if (!lastTextNode) {
        lastTextNode = getLastVisibleElement(container);
      }

      // 如果还是找不到，直接在容器末尾插入
      const targetParent = lastTextNode?.parentNode || container;
      const cursorMarker = document.createElement("span");

      // 确保光标样式正确应用
      cursorMarker.className = "typing-cursor";

      // 设置关键的内联样式确保动画运行
      cursorMarker.style.animation = "blink-caret 0.75s step-end infinite";
      cursorMarker.style.animationPlayState = "running";

      try {
        if (lastTextNode && lastTextNode.parentNode) {
          // 在最后一个文本节点后插入标记
          if (lastTextNode.nextSibling) {
            lastTextNode.parentNode.insertBefore(
              cursorMarker,
              lastTextNode.nextSibling,
            );
          } else {
            lastTextNode.parentNode.appendChild(cursorMarker);
          }
        } else {
          // 后备方案：直接在容器末尾插入
          container.appendChild(cursorMarker);
        }

        // 确保动画立即开始
        // 强制重新计算样式以触发动画（触发重排）
        void cursorMarker.offsetWidth;

        // 如果动画没有运行，强制重新应用
        const computedStyle = window.getComputedStyle(cursorMarker);
        if (
          computedStyle.animationName === "none" ||
          !computedStyle.animationName
        ) {
          cursorMarker.style.animation = "none";
          setTimeout(() => {
            cursorMarker.style.animation =
              "blink-caret 0.75s step-end infinite";
          }, 0);
        }
      } catch (e) {
        // 静默忽略错误
      }
    };

    // 使用多次延迟确保 Streamdown 完全渲染
    const updateWithDelay = () => {
      // 第一次延迟：等待 React 渲染
      requestAnimationFrame(() => {
        // 第二次延迟：等待 Streamdown 处理
        setTimeout(() => {
          // 第三次延迟：确保 DOM 完全更新
          requestAnimationFrame(() => {
            updateCursorPosition();
          });
        }, 10);
      });
    };

    // 初始更新
    updateWithDelay();

    // 使用 MutationObserver 监听 DOM 变化，确保在 Streamdown 更新后重新定位光标
    let cleanupTimer: NodeJS.Timeout | null = null;
    const observer = new MutationObserver(() => {
      // 延迟清理新增的下划线，避免在 DOM 正在变化时删除节点
      // 使用 requestAnimationFrame 确保在浏览器渲染周期中执行
      if (cleanupTimer) {
        clearTimeout(cleanupTimer);
      }
      cleanupTimer = setTimeout(() => {
        // 使用 requestAnimationFrame 确保在合适的时机执行
        requestAnimationFrame(() => {
          // 再次延迟，确保 Streamdown 完全更新 DOM
          requestAnimationFrame(() => {
            removeTrailingUnderscores(container);
            cleanupTimer = null;
          });
        });
      }, 100); // 延迟 100ms，确保 DOM 更新完成

      // 使用 ref 检查最新的 isStop 状态
      if (isStopRef.current) {
        // 如果已停止，立即清除光标
        removeCursor();
        return;
      }

      if (showCursor) {
        updateWithDelay();
      }
    });

    // 观察容器的子节点变化
    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // 使用 setInterval 定期更新光标位置（防止 MutationObserver 遗漏某些变化）
    const intervalId = setInterval(() => {
      // 使用 ref 检查最新的 isStop 状态
      if (isStopRef.current) {
        removeCursor();
        return;
      }

      if (showCursor) {
        const existingCursor = container.querySelector(".typing-cursor");
        if (!existingCursor || !container.contains(existingCursor)) {
          updateWithDelay();
        }
      }
    }, 100); // 每 100ms 检查一次

    return () => {
      observer.disconnect();
      clearInterval(intervalId);
      if (cleanupTimer) {
        clearTimeout(cleanupTimer);
      }
      // 清理时也移除光标
      removeCursor();
    };
  }, [value, showCursor, isStop]);

  return (
    <div className="w-full" ref={containerRef}>
      {errorMessage ? (
        <div className="text-[13px] font-normal font-['PingFang SC'] flex items-center">
          {errorMessage}
        </div>
      ) : value ? (
        <div className="w-full max-w-screen-lg border-muted bg-background sm:mb-[100px] ai-clamp-height streamdown-container prose prose-lg dark:prose-invert prose-headings:font-title font-default focus:outline-none text-[13px] font-normal">
          <Streamdown
            mode="streaming"
            parseIncompleteMarkdown={true}
            rehypePlugins={[rehypeRaw]}
          >
            {value}
          </Streamdown>
        </div>
      ) : toolCallingStatus ? (
        <div className="text-[#9ea6b8] text-[13px] font-normal font-['PingFang SC'] flex items-center">
          {toolCallingStatus}
          <span className="generating-dots ml-[4px]">
            <span></span>
            <span></span>
            <span></span>
          </span>
        </div>
      ) : showCursor ? (
        <div className="typing-cursor"></div>
      ) : null}
      {previewImage && (
        <Image
          src={previewImage}
          alt="预览"
          style={{ display: "none" }}
          preview={{
            visible: previewVisible,
            onVisibleChange: (visible) => {
              setPreviewVisible(visible);
              if (!visible) {
                setPreviewImage("");
              }
            },
            mask: "预览",
          }}
        />
      )}
    </div>
  );
};

export default StreamdownRenderer;
