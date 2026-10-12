import { describe, it, expect } from "vitest";
import { bootstrapFailureResponse } from "../src/routes/bootstrap-failure-response.js";

describe("bootstrapFailureResponse — project rig with an existing stopped rig", () => {
  it("is a 409 conflict carrying code project_rig_exists, so the CLI can ask resume or fresh", () => {
    const { status, body } = bootstrapFailureResponse({
      runId: "r", status: "failed", errors: ["already has a stopped rig"], warnings: [],
      stages: [{ stage: "resolve_spec", status: "failed", detail: { code: "project_rig_exists", rigName: "eztrack" } }],
    }, "apply");
    expect(status).toBe(409);
    expect(body.code).toBe("project_rig_exists");
  });

  it("a project_rig refusal (no --cwd) stays a plain failure, not the resume/fresh conflict", () => {
    const { status, body } = bootstrapFailureResponse({
      runId: "r", status: "failed", errors: ["team is a project rig"], warnings: [],
      stages: [{ stage: "resolve_spec", status: "failed", detail: { code: "project_rig" } }],
    }, "apply");
    expect(status).toBe(400);
    expect(body.code).toBe("project_rig");
  });
});
