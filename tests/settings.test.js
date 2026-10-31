import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import app from "../index.js";
import {
  connectTestDb,
  clearDb,
  disconnectTestDb,
  createUserAndToken,
  authHeader,
  agent,
} from "./helpers.js";

process.env.VITEST = "true";
process.env.JWT_SECRET = process.env.JWT_SECRET || "ci-test-secret";

beforeAll(async () => {
  await connectTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await clearDb();
});

describe("settings", () => {
  it("requires auth", async () => {
    const res = await agent(app).get("/api/settings");
    expect(res.status).toBe(401);
  });

  it("saves and masks secrets", async () => {
    const { token } = await createUserAndToken({
      stripSecrets: true,
      username: "settingsuser",
      email: "settings@example.com",
    });

    const put = await agent(app)
      .put("/api/settings")
      .set(authHeader(token))
      .send({
        githubUsername: "octocat",
        githubToken: "ghp_abcdef123456",
        groqKey: "gsk_groqabcdef",
      });

    expect(put.status).toBe(200);

    const get = await agent(app)
      .get("/api/settings")
      .set(authHeader(token));

    expect(get.status).toBe(200);
    expect(get.body.hasGithubToken).toBe(true);
    expect(get.body.hasGroqKey).toBe(true);
    expect(get.body.githubToken).toContain("••••");
    expect(get.body.groqKey).toContain("••••");
  });

  it("rejects empty update", async () => {
    const { token } = await createUserAndToken({
      username: "emptyupd",
      email: "emptyupd@example.com",
    });

    const res = await agent(app)
      .put("/api/settings")
      .set(authHeader(token))
      .send({});

    expect(res.status).toBe(400);
  });

  it("saves several Groq keys, adds backups and clears them", async () => {
    const { token } = await createUserAndToken({
      stripSecrets: true,
      username: "multikey",
      email: "multikey@example.com",
    });
    const put = (body) => agent(app).put("/api/settings").set(authHeader(token)).send(body);
    const get = () => agent(app).get("/api/settings").set(authHeader(token));

    expect((await put({ groqKey: "gsk_first1111\ngsk_second2222" })).status).toBe(200);
    expect((await put({ groqKey: "gsk_third3333, gsk_first1111" })).body.groqKeyCount).toBe(3);
    const saved = await get();
    expect(saved.body.groqKeys).toHaveLength(3);
    expect(saved.body.groqKeys[2]).toMatch(/^•+3333$/);
    expect(JSON.stringify(saved.body)).not.toContain("gsk_");

    const { resolveCredentials } = await import("../services/credentials.js");
    const User = (await import("../models/User.js")).default;
    const user = await User.findOne({ username: "multikey" });
    expect(resolveCredentials(user).groqKeys.slice(0, 3)).toEqual(["gsk_first1111", "gsk_second2222", "gsk_third3333"]);

    expect((await put({ clearGroqKeys: true })).status).toBe(200);
    expect((await get()).body.hasGroqKey).toBe(false);
  });
});
