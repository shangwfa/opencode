import { afterEach, describe, expect, test, vi } from "vitest";
import {
  fetchProjectIntakeConfirmJob,
  normalizeProjectIntakeConfirmJobPollResponse,
} from "./confirmJob";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("project intake confirm job API", () => {
  test("normalizes pending confirm job response", () => {
    const job = normalizeProjectIntakeConfirmJobPollResponse({
      job_id: "ses_pending",
      status: "pending_confirm",
      children: [],
    });

    expect(job).toEqual({
      job_id: "ses_pending",
      status: "pending_confirm",
      children: [],
    });
  });

  test("folds legacy intermediate child statuses into preparing", () => {
    for (const legacy of [
      "creating_session",
      "linking_group",
      "sending_message",
    ] as const) {
      const job = normalizeProjectIntakeConfirmJobPollResponse({
        job_id: "ses_1",
        status: "running",
        children: [
          {
            app_id: "app-a",
            item_seq: 0,
            status: legacy,
            title: "任务 A",
            target_gitlab: "https://gitlab.example.com/a.git",
            base_branch: "master",
            requirement_message: "需求正文",
            messageSent: false,
          },
        ],
      });

      expect(job.children[0]?.status).toBe("preparing");
    }
  });

  test("normalizes preparing child status", () => {
    const job = normalizeProjectIntakeConfirmJobPollResponse({
      job_id: "ses_prep",
      status: "running",
      children: [
        {
          app_id: "app-b",
          item_seq: 0,
          status: "preparing",
          title: "任务 B",
          target_gitlab: "",
          base_branch: "master",
          requirement_message: "",
          messageSent: false,
          initSessionJobId: "job_init_b",
        },
      ],
    });

    expect(job.children[0]?.status).toBe("preparing");
  });

  test("normalizes success and failed job response", () => {
    expect(
      normalizeProjectIntakeConfirmJobPollResponse({
        job_id: "ses_2",
        status: "success",
        result: { ok: true },
        children: [],
      }).status,
    ).toBe("success");

    expect(
      normalizeProjectIntakeConfirmJobPollResponse({
        job_id: "ses_3",
        status: "failed",
        error: "创建失败",
        children: [
          {
            app_id: "app-a",
            item_seq: 0,
            status: "failed",
            title: "任务 A",
            target_gitlab: "",
            base_branch: "master",
            requirement_message: "",
            messageSent: false,
            error: "子任务失败",
          },
        ],
      }).children[0]?.error,
    ).toBe("子任务失败");
  });

  test("returns null for 404 job lookup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );

    await expect(fetchProjectIntakeConfirmJob("missing")).resolves.toBeNull();
  });

  test("rejects invalid job status", () => {
    expect(() =>
      normalizeProjectIntakeConfirmJobPollResponse({
        job_id: "ses_bad",
        status: "waiting",
        children: [],
      }),
    ).toThrow("项目状态响应缺少有效状态");
  });
});
