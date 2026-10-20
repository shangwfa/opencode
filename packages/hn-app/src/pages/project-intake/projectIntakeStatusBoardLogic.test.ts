import { describe, expect, test } from "vitest";
import {
  isProjectIntakeJobTerminal,
  projectIntakeChildSteps,
  projectIntakeJobStats,
  shouldPollProjectIntakeJob,
} from "./projectIntakeStatusBoardLogic";
import type { ProjectIntakeConfirmJobChildStatus } from "@/api/project-intake/confirmJob";

describe("project intake status board logic", () => {
  test.each([
    ["queued", ["current", "todo", "todo"]],
    ["preparing", ["done", "current", "todo"]],
    ["success", ["done", "done", "done"]],
    ["failed", ["done", "done", "failed"]],
  ] satisfies Array<[ProjectIntakeConfirmJobChildStatus, string[]]>)(
    "maps %s to step states",
    (status, states) => {
      expect(projectIntakeChildSteps(status).map((step) => step.state)).toEqual(
        states,
      );
    },
  );

  test("counts total, success, failed and pending children", () => {
    expect(
      projectIntakeJobStats({
        job_id: "ses_1",
        status: "running",
        children: [
          {
            app_id: "a",
            item_seq: 0,
            status: "success",
            title: "",
            target_gitlab: "",
            base_branch: "",
            requirement_message: "",
            messageSent: true,
          },
          {
            app_id: "b",
            item_seq: 0,
            status: "failed",
            title: "",
            target_gitlab: "",
            base_branch: "",
            requirement_message: "",
            messageSent: false,
          },
          {
            app_id: "c",
            item_seq: 0,
            status: "preparing",
            title: "",
            target_gitlab: "",
            base_branch: "",
            requirement_message: "",
            messageSent: false,
          },
        ],
      }),
    ).toEqual({ total: 3, success: 1, failed: 1, pending: 1 });
  });

  test("treats only success and failed as terminal", () => {
    expect(isProjectIntakeJobTerminal("pending_confirm")).toBe(false);
    expect(isProjectIntakeJobTerminal("queued")).toBe(false);
    expect(isProjectIntakeJobTerminal("running")).toBe(false);
    expect(isProjectIntakeJobTerminal("success")).toBe(true);
    expect(isProjectIntakeJobTerminal("failed")).toBe(true);
  });

  test("continues polling for empty and non-terminal jobs", () => {
    expect(shouldPollProjectIntakeJob(null, "")).toBe(true);
    expect(
      shouldPollProjectIntakeJob(
        { job_id: "ses_1", status: "pending_confirm", children: [] },
        "",
      ),
    ).toBe(true);
    expect(
      shouldPollProjectIntakeJob({ job_id: "ses_1", status: "queued", children: [] }, ""),
    ).toBe(true);
    expect(
      shouldPollProjectIntakeJob({ job_id: "ses_1", status: "running", children: [] }, ""),
    ).toBe(true);
  });

  test("stops polling for terminal jobs and errors", () => {
    expect(
      shouldPollProjectIntakeJob({ job_id: "ses_1", status: "success", children: [] }, ""),
    ).toBe(false);
    expect(
      shouldPollProjectIntakeJob({ job_id: "ses_1", status: "failed", children: [] }, ""),
    ).toBe(false);
    expect(shouldPollProjectIntakeJob(null, "查询失败")).toBe(false);
  });

  test("counts empty children as zero", () => {
    expect(
      projectIntakeJobStats({
        job_id: "ses_1",
        status: "pending_confirm",
        children: [],
      }),
    ).toEqual({ total: 0, success: 0, failed: 0, pending: 0 });
  });
});
