import { describe, expect, it, vi } from "vitest";
import {
  VisionError,
  describeImage,
  describeImages,
  parseImageDataUrl,
} from "../services/vision.js";
import { buildRequestBlock } from "../services/prompts.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function fakeModel(replies) {
  const calls = [];
  const createModel = vi.fn((options) => ({
    invoke: vi.fn(async (messages) => {
      calls.push({ options, messages });
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return { content: next };
    }),
  }));
  return { createModel, calls };
}

describe("parseImageDataUrl", () => {
  it("accepts supported images and rejects everything else", () => {
    expect(parseImageDataUrl(PNG).mimeType).toBe("image/png");
    expect(() => parseImageDataUrl("not a data url")).toThrow(VisionError);
    expect(() => parseImageDataUrl("data:image/svg+xml;base64,PHN2Zz4=")).toThrow(/Unsupported/);
    const huge = `data:image/png;base64,${"A".repeat(6 * 1024 * 1024)}`;
    expect(() => parseImageDataUrl(huge)).toThrow(/4 MB/);
  });
});

describe("describeImage", () => {
  it("sends the image and the instruction to the vision model", async () => {
    const { createModel, calls } = fakeModel(["## Layout\n- hero slider with 3 slides"]);
    const text = await describeImage(
      { dataUrl: PNG, name: "slider.png", instruction: "fix the slider" },
      { apiKeys: ["gsk_a"], createModel },
    );
    expect(text).toContain("hero slider");
    expect(calls[0].options.apiKey).toBe("gsk_a");
    const human = calls[0].messages[1].content;
    expect(human[0].text).toContain("fix the slider");
    expect(human[1]).toEqual({ type: "image_url", image_url: { url: PNG } });
  });

  it("moves to the next key on a rate limit, and stops on other errors", async () => {
    const limited = Object.assign(new Error("Rate limit reached"), { status: 429 });
    const ok = fakeModel([limited, "described"]);
    await expect(describeImage({ dataUrl: PNG }, { apiKeys: ["k1", "k2"], createModel: ok.createModel })).resolves.toBe("described");
    expect(ok.calls.map((c) => c.options.apiKey)).toEqual(["k1", "k2"]);

    const broken = fakeModel([Object.assign(new Error("model not found"), { status: 404 }), "never"]);
    await expect(
      describeImage({ dataUrl: PNG }, { apiKeys: ["k1", "k2"], createModel: broken.createModel }),
    ).rejects.toThrow(/model not found/);
    expect(broken.calls).toHaveLength(1);
  });

  it("needs a key", async () => {
    await expect(describeImage({ dataUrl: PNG }, { apiKeys: [] })).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });
  });
});

describe("describeImages", () => {
  it("waits once when every key is rate limited, as Groq asks", async () => {
    const limited = Object.assign(new Error("Rate limit reached. Please try again in 7.5s."), { status: 429 });
    const { createModel, calls } = fakeModel([limited, limited, "described"]);
    const wait = vi.fn(async () => {});
    await expect(describeImage({ dataUrl: PNG }, { apiKeys: ["k1", "k2"], createModel, wait })).resolves.toBe("described");
    expect(wait).toHaveBeenCalledWith(8000);
    expect(calls).toHaveLength(3);
  });

  it("describes several images in one call and splits the reply", async () => {
    const { createModel, calls } = fakeModel(["=== IMAGE 1 ===\nfirst\n\n=== IMAGE 2 ===\nsecond"]);
    const out = await describeImages(
      [
        { name: "a.png", dataUrl: PNG, thumbnail: PNG },
        { dataUrl: PNG, thumbnail: "javascript:alert(1)" },
      ],
      "make it match",
      { apiKeys: ["k"], createModel },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].messages[1].content.filter((p) => p.type === "image_url")).toHaveLength(2);
    expect(out).toEqual([
      { name: "a.png", mimeType: "image/png", size: expect.any(Number), thumbnail: PNG, description: "first" },
      { name: "image-2", mimeType: "image/png", size: expect.any(Number), thumbnail: null, description: "second" },
    ]);
  });

  it("keeps the whole reply for every image when it can't be split", async () => {
    const { createModel } = fakeModel(["one combined description"]);
    const out = await describeImages([{ dataUrl: PNG }, { dataUrl: PNG }], "x", { apiKeys: ["k"], createModel });
    expect(out.map((a) => a.description)).toEqual(["one combined description", "one combined description"]);
  });

  it("rejects more than 4 images", async () => {
    const five = Array.from({ length: 5 }, () => ({ dataUrl: PNG }));
    await expect(describeImages(five, "x", { apiKeys: ["k"] })).rejects.toMatchObject({ code: "INVALID_IMAGE" });
  });
});

describe("request block with images", () => {
  it("adds image descriptions under the instruction they belong to", () => {
    const text = buildRequestBlock({
      instruction: "match this design",
      attachments: [{ name: "mock.png", description: "A dark hero with a blue button" }],
      refinements: [{ instruction: "now fix this bug", applied: false, attachments: [{ description: "Error: x is undefined" }] }],
    });
    expect(text).toContain("match this design");
    expect(text).toContain("[Attached image 1: mock.png");
    expect(text).toContain("A dark hero with a blue button");
    expect(text).toContain("Error: x is undefined");
  });
});
