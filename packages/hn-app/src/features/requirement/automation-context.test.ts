import { describe, expect, test } from "vitest";
import {
  appendAutomationContext,
  buildAutomationContextText,
  resolveAutomationContext,
} from "./automation-context";

const proxyBase =
  "https://preview.example.com/session/ses_x/proxy/5174/";

describe("automation context", () => {
  test("combines the preview base with the current route", () => {
    const context = resolveAutomationContext({
      previewBaseUrl: proxyBase,
      previewUrl: "/detail?id=1#top",
      autoInjectToken: true,
      customToken: "custom-token",
    });

    expect(context).toMatchObject({
      previewUrl:
        "https://preview.example.com/session/ses_x/proxy/5174/detail?id=1#top",
      accessToken: "custom-token",
      ready: true,
    });
  });

  test("prefers a custom token and falls back to the local token", () => {
    expect(
      resolveAutomationContext({
        previewBaseUrl: proxyBase,
        previewUrl: "/",
        autoInjectToken: true,
        customToken: " custom-token ",
        readAccessToken: () => "local-token",
      }).accessToken,
    ).toBe("custom-token");

    expect(
      resolveAutomationContext({
        previewBaseUrl: proxyBase,
        previewUrl: "/",
        autoInjectToken: true,
        customToken: "",
        readAccessToken: () => " local-token ",
      }).accessToken,
    ).toBe("local-token");
  });

  test("uses null when token injection is disabled or no token exists", () => {
    expect(
      resolveAutomationContext({
        previewBaseUrl: proxyBase,
        previewUrl: "/",
        autoInjectToken: false,
        customToken: "custom-token",
        readAccessToken: () => "local-token",
      }).accessToken,
    ).toBeNull();

    expect(
      resolveAutomationContext({
        previewBaseUrl: proxyBase,
        previewUrl: "/",
        autoInjectToken: true,
        customToken: "",
        readAccessToken: () => undefined,
      }).accessToken,
    ).toBeNull();
  });

  test("marks missing or relative preview urls as unavailable", () => {
    expect(
      resolveAutomationContext({
        previewBaseUrl: "",
        previewUrl: "/detail",
        autoInjectToken: false,
        customToken: "",
      }).ready,
    ).toBe(false);
    expect(
      resolveAutomationContext({
        previewBaseUrl: proxyBase,
        previewUrl: "",
        autoInjectToken: false,
        customToken: "",
      }).ready,
    ).toBe(false);
  });

  test("serializes special characters safely and appends after artifact context", () => {
    const automation = buildAutomationContextText({
      previewUrl: 'https://preview.example.com/path?value="quoted"',
      accessToken: 'token\n"secret"',
    });
    const combined = appendAutomationContext(
      "[Artifact Generation Context]\nartifactGenerationMode: detailed",
      automation,
    );

    expect(combined).toBe(
      '[Artifact Generation Context]\nartifactGenerationMode: detailed\n\n[Automation Context]\n{"preview_url":"https://preview.example.com/path?value=\\"quoted\\"","access_token":"token\\n\\"secret\\""}',
    );
    expect(JSON.parse(automation.split("\n")[1])).toEqual({
      preview_url: 'https://preview.example.com/path?value="quoted"',
      access_token: 'token\n"secret"',
    });
  });
});
