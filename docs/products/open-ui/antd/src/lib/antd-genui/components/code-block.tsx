"use client";

import { defineComponent } from "@openuidev/react-lang";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { z } from "zod";

const CodeBlockSchema = z.object({
  code: z.string(),
  language: z.string().optional(),
  title: z.string().optional(),
});

export const CodeBlock = defineComponent({
  name: "CodeBlock",
  props: CodeBlockSchema,
  description: "Syntax-highlighted code block with optional language and title.",
  component: ({ props }) => {
    const code = props.code == null ? "" : String(props.code);
    const language = props.language?.toLowerCase() || "text";
    return (
      <div style={{ borderRadius: 8, border: "1px solid var(--ant-color-border)", overflow: "hidden" }}>
        {props.title && (
          <div style={{
            borderBottom: "1px solid var(--ant-color-border)",
            padding: "6px 16px",
            fontSize: 12,
            color: "var(--ant-color-text-secondary)",
            background: "var(--ant-color-fill-tertiary)",
          }}>
            {props.title}
            {props.language && <span style={{ marginLeft: 8, opacity: 0.6 }}>{props.language}</span>}
          </div>
        )}
        <SyntaxHighlighter
          language={language}
          style={oneLight}
          customStyle={{ margin: 0, padding: "1rem", background: "transparent" }}
          codeTagProps={{
            style: { fontSize: 13, fontFamily: "SF Mono, Monaco, monospace", fontWeight: 400, lineHeight: 1.6 },
          }}
        >
          {code}
        </SyntaxHighlighter>
      </div>
    );
  },
});