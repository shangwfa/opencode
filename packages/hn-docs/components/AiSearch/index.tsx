import { useEffect, useState, useRef } from "react";
import { Divider } from "antd";
import { sendBuryById } from "@xybot/bury";

import { StreamService } from "@/utils/streamService";
import { env } from "@/utils/env";

import StreamdownRenderer from "./components/StreamdownRenderer";

import AIIcon from "/static/img/AI.svg";
import StopCircleIcon from "/static/img/stop-circle.svg";
import DownIcon from "/static/img/down.svg";
import { getLang } from "@/utils/getLang";

const WORK_FLOW_ID = "a3ca7ba5-60b7-4fd5-8fba-d2c07c012f9b";

export default function AiSearch({ keywords }: { keywords: string }) {
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [isInoperable, setIsInoperable] = useState<boolean>(false);
  const streamIns = useRef<any>();
  const cacheStr = useRef(""); // 缓存未完成的链接
  const cacheFlag = useRef(false); // 缓存未完成的链接

  const [isFold, setIsFold] = useState<boolean>(false);
  const [isGenerate, setIsGenerate] = useState<boolean>(false); // 是否生成中
  const [isStop, setIsStop] = useState<boolean>(false); // 是否停止生成
  const [aiAnswer, setAiAnswer] = useState<string>("");
  const currentAnswer = useRef("");

  const answerStr = useRef("");
  const timer = useRef<any>();
  const sseStatus = useRef("");
  const realAnswer = useRef("");
  const foldStatus = useRef(false);
  const isResettingRef = useRef(false); // 标记是否正在重置，用于在重置期间忽略 onRendered 的调用

  // yddoc 流独立的状态管理
  const [yddocMarkdown, setYddocMarkdown] = useState<string>("");
  const yddocMarkdownRef = useRef("");
  const yddocAnswerStr = useRef(""); // yddoc 流的待显示文本缓存
  const yddocCurrentAnswer = useRef(""); // yddoc 流当前显示的文本
  const [isYddocStream, setIsYddocStream] = useState<boolean>(false);
  const [toolCallingStatus, setToolCallingStatus] = useState<string | null>(
    null,
  ); // 工具调用状态文案
  const toolCallingStatusRef = useRef<string | null>(null); // 用于在闭包中访问最新状态
  const [errorMessage, setErrorMessage] = useState<string | null>(null); // 错误信息

  useEffect(() => {
    // 设置重置标志，在重置期间忽略 onRendered 的调用
    isResettingRef.current = true;
    // 立即重置 foldStatus，确保后续的 onRendered 调用时能正确检查
    foldStatus.current = false;
    setIsGenerate(false);
    setIsStop(false);
    setIsFold(false);

    currentAnswer.current = "";
    answerStr.current = "";
    realAnswer.current = "";
    cacheStr.current = "";
    cacheFlag.current = false;
    setAiAnswer("");
    yddocMarkdownRef.current = "";
    yddocAnswerStr.current = "";
    yddocCurrentAnswer.current = "";
    setYddocMarkdown("");
    setIsYddocStream(false);
    setToolCallingStatus(null);
    setErrorMessage(null); // 清除错误状态
    // 注意：reviewStatusTimer 是在 callYddocStream 函数内部定义的，会在函数执行时自动清理
    cleanAIContentHeight();
    streamIns.current?.stop();
    timer.current && clearInterval(timer.current);

    // 使用 setTimeout 确保重置操作完成后再清除重置标志
    // 这样可以避免在重置期间 onRendered 被调用
    setTimeout(() => {
      isResettingRef.current = false;
    }, 0);

    if (keywords) {
      onInputTrigger(keywords);
    }
    return () => clearInterval(timer.current);
  }, [keywords]);

  // 前端流式处理（用于 power 流）
  const settingStream = () => {
    timer.current = setInterval(() => {
      // 检查是否应该结束打字机效果
      // 条件：SSE 已结束 且 缓存为空 且 当前显示的内容等于完整内容
      if (
        sseStatus.current === "success" &&
        answerStr.current.length === 0 &&
        currentAnswer.current === realAnswer.current
      ) {
        clearInterval(timer.current);
        setIsInoperable(false);
        setIsGenerate(false);
        setIsStop(true);
        return;
      }

      // 如果缓存为空但 SSE 还未结束，继续等待
      if (answerStr.current.length === 0) {
        return;
      }

      // 从缓存中取出一个字符并显示
      const char = answerStr.current.charAt(0);
      answerStr.current = answerStr.current.slice(1);

      currentAnswer.current += char;
      setAiAnswer(currentAnswer.current);
      if (!foldStatus.current) {
        getAIContentHeight();
      }
    }, 20);
  };

  // 检查文本末尾是否在未闭合的 HTML 标签中
  const isInUnclosedHtmlTag = (text: string): boolean => {
    const lastOpenIndex = text.lastIndexOf("<");
    const lastCloseIndex = text.lastIndexOf(">");
    // 如果最后一个 < 在最后一个 > 之后，说明有未闭合的标签
    return lastOpenIndex > lastCloseIndex;
  };

  // power: SSE 流式请求
  const callPowerStream = (keyword?: string) => {
    const queryText = keyword;
    streamIns.current = new StreamService(
      `https://power-api.yingdao.com/oapi/power/v1/rest/flow/${WORK_FLOW_ID}/execute/stream`,
      {
        method: "POST",
        body: JSON.stringify({
          input: { input_text_0: queryText },
        }),
        headers: {
          Authorization: "Bearer AP_fDGlYfukTisoXyCG",
          "content-type": "application/json",
          accept: "text/event-stream",
        },
      },
    );

    streamIns.current.onmessage((details: string) => {
      setIsRunning(false);
      if (details === "[DONE]") {
        return;
      }
      const result = JSON.parse(details);
      const answer = result.data.result.output_text_0;

      if (result.data.status === "running") {
        setIsGenerate(true);
        setIsStop(false);
        answerStr.current += answer;
        realAnswer.current += answer;

        if (sseStatus.current !== "running") {
          settingStream();
        }
        sseStatus.current = "running";
      }

      if (result.data.status === "success") {
        sseStatus.current = "success";
        const buryParams = {
          keyword: keyword,
          source: "aiSearch",
          answer: realAnswer.current,
        };
        sendBuryById("71bb6e76-db90-4af4-849d-cb1db840d8d2", buryParams);
        return;
      }
    });
    streamIns.current.onerror((err: any) => {
      setIsInoperable(false);
    });
  };

  // yddoc: SSE 流式请求
  const callYddocStream = (keyword?: string) => {
    const queryText = keyword;
    const requestStartTime = Date.now();
    let reviewStatusTimer: NodeJS.Timeout | null = null; // 用于延迟更新"正在审核"状态的定时器

    setIsYddocStream(true);
    setToolCallingStatus(null); // 初始化为 null，等待根据 type 设置状态文案
    toolCallingStatusRef.current = null;
    yddocMarkdownRef.current = "";
    // 不再使用缓存层，直接输出
    setYddocMarkdown("");

    const yddocApiUrl = env.YDDOC_API_URL;
    if (!yddocApiUrl) {
      callPowerStream(keyword);
      return;
    }

    streamIns.current = new StreamService(
      `${yddocApiUrl}/api/agents/documentAgent/stream`,
      {
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content: queryText }],
        }),
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
      },
    );

    let hasReceivedToolResult = false; // 标记是否已经收到过 tool-result，用于判断 step-start 属于哪个阶段
    streamIns.current.onmessage((details: string) => {
      setIsRunning(false);
      if (details === "[DONE]") {
        return;
      }

      const result = JSON.parse(details);

      // 根据不同的 type 设置对应的状态文案
      const type = result.type;

      // start 到 tool-call：显示"正在思考"
      if (
        type === "start" ||
        type === "tool-call-input-streaming-start" ||
        type === "tool-call-delta" ||
        type === "tool-call-input-streaming-end" ||
        type === "tool-call"
      ) {
        setToolCallingStatus("正在思考");
        toolCallingStatusRef.current = "正在思考";
      } else if (type === "step-start") {
        // 判断是第一次 step-start（第一阶段）还是后续的 step-start（第二阶段）
        if (!hasReceivedToolResult) {
          // 第一次 step-start，属于第一阶段：显示"正在思考"
          setToolCallingStatus("正在思考");
          toolCallingStatusRef.current = "正在思考";
        } else {
          // 后续的 step-start，属于第二阶段：显示"正在生成AI回答"
          setToolCallingStatus("正在生成AI回答");
          toolCallingStatusRef.current = "正在生成AI回答";
        }
      } else if (type === "tool-result") {
        // tool-result：显示"正在审核xx篇来源"
        hasReceivedToolResult = true;
        try {
          // 计算 result.result.results 数组通过 documentId 去重的数量
          const results = result?.payload?.result?.results || [];
          const uniqueDocumentIds = new Set<string>();
          results.forEach((item: any) => {
            if (item?.documentId) {
              uniqueDocumentIds.add(item.documentId);
            }
          });
          const sourceCount = uniqueDocumentIds.size;
          const statusText = `正在审核${sourceCount}篇来源`;
          setToolCallingStatus(statusText);
          toolCallingStatusRef.current = statusText;
        } catch (error) {
          // 如果解析失败，使用默认文案
          console.error("[callYddocStream] 解析 tool-result 失败", error);
          const statusText = "正在审核来源";
          setToolCallingStatus(statusText);
          toolCallingStatusRef.current = statusText;
        }
      } else if (type === "step-finish" || type === "text-start") {
        // step-finish 到 text-delta：显示"正在生成AI回答"
        // 如果当前状态是"正在审核xx篇来源"，延迟1秒后再更新
        const currentStatus = toolCallingStatusRef.current;
        if (currentStatus && currentStatus.includes("正在审核")) {
          // 清除之前的定时器（如果有）
          if (reviewStatusTimer) {
            clearTimeout(reviewStatusTimer);
          }
          // 延迟1秒后更新状态
          reviewStatusTimer = setTimeout(() => {
            setToolCallingStatus("正在生成AI回答");
            toolCallingStatusRef.current = "正在生成AI回答";
            reviewStatusTimer = null;
          }, 1000);
        } else {
          // 如果当前不是"正在审核"状态，立即更新
          setToolCallingStatus("正在生成AI回答");
          toolCallingStatusRef.current = "正在生成AI回答";
        }
      }

      // 处理增量文本 - 直接输出，不使用缓存层
      if (result.type === "text-delta") {
        // 清除延迟更新定时器（如果有）
        if (reviewStatusTimer) {
          clearTimeout(reviewStatusTimer);
          reviewStatusTimer = null;
        }
        // 收到第一个 text-delta 时，退出工具调用阶段
        setToolCallingStatus(null);
        toolCallingStatusRef.current = null;
        const answer = result.payload?.text || "";
        setIsGenerate(true);
        setIsStop(false);
        yddocMarkdownRef.current += answer;
        realAnswer.current += answer;
        setYddocMarkdown(yddocMarkdownRef.current);
        sseStatus.current = "running";
      }

      // 处理完成事件
      if (result.type === "finish") {
        sseStatus.current = "success";
        setIsGenerate(false);
        setIsStop(true);
        setIsInoperable(false);
        // 清除延迟更新定时器（如果有）
        if (reviewStatusTimer) {
          clearTimeout(reviewStatusTimer);
          reviewStatusTimer = null;
        }
        setToolCallingStatus(null);
        toolCallingStatusRef.current = null;
        const buryParams = {
          keyword: keyword,
          source: "aiSearch",
          answer: realAnswer.current,
        };
        sendBuryById("71bb6e76-db90-4af4-849d-cb1db840d8d2", buryParams);
      }
    });

    streamIns.current.onerror((err: any) => {
      const errorTime = Date.now() - requestStartTime;
      console.error("[callYddocStream] 请求错误", {
        error: err,
        timestamp: new Date().toISOString(),
        errorTime: `${errorTime}ms`,
      });
      // 设置错误状态
      setErrorMessage("服务异常");
      setIsGenerate(false);
      setIsRunning(false);
      setIsInoperable(false);
      setIsYddocStream(false);
      setToolCallingStatus(null);
      // 停止流式服务
      streamIns.current?.stop();
      // 清除定时器
      timer.current && clearInterval(timer.current);
      // 错误时回退到 power 流式请求
      // callPowerStream(keyword);
    });
  };

  const onInputTrigger = async (keyword?: string) => {
    setIsRunning(true);
    setIsInoperable(true);
    setErrorMessage(null); // 清除之前的错误状态

    const searchSource = env.AI_SEARCH_SOURCE;

    if (searchSource === "yddoc") {
      // yddoc: SSE 流式请求
      callYddocStream(keyword);
    } else {
      // power: SSE 流式请求 (默认)
      callPowerStream(keyword);
    }
  };

  const onStreamClose = () => {
    streamIns.current?.stop();
    setIsGenerate(false);
    clearInterval(timer.current);
    setIsStop(true);
    setToolCallingStatus(null);
    if (isYddocStream) {
      setIsInoperable(false);
      // 由于不再使用缓存层，直接停止即可
    }
  };

  const cleanAIContentHeight = () => {
    const element = document.querySelector(".ai-clamp-height") as HTMLElement;
    if (element) {
      element.style.maxHeight = "unset";
      element.classList.remove("clamped");
    }
    setIsFold(false);
    foldStatus.current = false;
  };

  const onFold = () => {
    const element = document.querySelector(".ai-clamp-height") as HTMLElement;
    if (element) {
      element.style.maxHeight = "unset";
      element.classList.remove("clamped");
      setIsFold(false);
      foldStatus.current = true; // 标记已展开，后续不再检查是否需要折叠
    }
  };

  // 检查内容高度（统一使用 ai-clamp-height）
  const getAIContentHeightImpl = () => {
    const element = document.querySelector(".ai-clamp-height") as HTMLElement;
    if (!element) {
      return;
    }

    const maxHeight = window.innerHeight - 400;
    const currentMaxHeight = element.style.maxHeight;
    const isUnset = currentMaxHeight === "unset" || currentMaxHeight === "";

    // 临时移除高度限制以获取完整高度
    element.style.maxHeight = "unset";
    const fullHeight = element.clientHeight;

    // 恢复原来的高度限制（如果有），或者设置新的限制
    if (isUnset) {
      element.style.maxHeight = `${maxHeight}px`;
      element.classList.remove("clamped");
    } else {
      element.style.maxHeight = currentMaxHeight;
    }

    // 检查是否需要显示"更多"按钮
    if (fullHeight > maxHeight) {
      setIsFold(true);
      if (currentMaxHeight !== "unset" && currentMaxHeight !== "") {
        element.classList.add("clamped");
      }
    } else {
      setIsFold(false);
      element.classList.remove("clamped");
    }
  };

  const getAIContentHeight = () => {
    getAIContentHeightImpl();
  };

  const onRendered = () => {
    // 如果正在重置，忽略本次调用
    if (isResettingRef.current) {
      return;
    }

    // 如果内容为空，不进行高度检查，避免在重置期间检查到旧内容
    const hasContent = isYddocStream
      ? yddocMarkdown.trim().length > 0
      : aiAnswer.trim().length > 0;

    if (!hasContent) {
      return;
    }

    if (!foldStatus.current) {
      getAIContentHeight();
    }
  };

  const onJumpAP = () => {
    window.open("https://www.yingdao.com/ai-power/");
  };

  return (
    <div className="w-full">
      <div className="flex items-center mb-[10px]">
        <AIIcon className="w-[16px] mr-[8px]" />
        <span className="text-[#1f2633] text-sm font-semibold font-['PingFang SC']">
          {getLang("AI_answers")}
        </span>
      </div>

      <div>
        <StreamdownRenderer
          value={isYddocStream ? yddocMarkdown : aiAnswer}
          isRunning={isRunning}
          isStop={isStop}
          toolCallingStatus={isYddocStream ? toolCallingStatus : null}
          errorMessage={isYddocStream ? errorMessage : null}
          onRendered={onRendered}
        />
      </div>
      <div className="flex items-center justify-between mt-[16px]">
        {isFold && (
          <div
            onClick={() => onFold()}
            className="text-[#0e79f4] text-[13px] font-normal font-['PingFang SC'] cursor-pointer flex items-center"
            data-bury-id="bdbc8338-e2ca-47d1-b176-581588a0e089"
          >
            {getLang("expand")}
            <DownIcon className="ml-[6px]" />
          </div>
        )}
        <div className="flex items-center">
          {isGenerate && (
            <span
              className="w-[88px] h-[30px] mr-[8px] bg-white rounded-lg shadow-[0px_1px_2px_0px_rgba(16,24,40,0.05)] border border-[#d0d5dd] justify-center items-center gap-1 inline-flex cursor-pointer"
              onClick={() => onStreamClose()}
              data-bury-id="2362e071-60b5-4f00-8dc9-5ae1acda1ba5"
            >
              <StopCircleIcon />
              <span className="text-[#1f2633] text-[13px] font-normal font-['PingFang SC']">
                {getLang("stop_generating")}
              </span>
            </span>
          )}
          <span className="text-[#9ea6b8] text-xs font-normal font-['PingFang SC']">
            {getLang("this_answer_is_provided_by")}
            <a
              className="px-[4px] cursor-pointer underline hover:text-[#1f2633]"
              onClick={onJumpAP}
            >
              {getLang("AI_Power")}
            </a>
            {getLang("generated")}, {getLang("content_for_reference_only")}
          </span>
        </div>
      </div>
      <Divider className="mb-[8px]" />
    </div>
  );
}
