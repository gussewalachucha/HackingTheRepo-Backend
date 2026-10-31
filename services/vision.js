// Image understanding for job attachments: a Groq vision model (through
// LangChain) turns each uploaded image into a detailed text description. The
// code-writing models are text only, so the descriptions — not the images —
// are stored on the job and added to the request the pipeline sends them.
import { ChatGroq } from "@langchain/groq";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

// A free Groq model with image input (Groq retired the Llama 4 vision models).
export const DEFAULT_VISION_MODEL = "qwen/qwen3.8-27b";
export const MAX_IMAGES = 4;
// Groq accepts base64 images up to 4 MB per request.
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_THUMBNAIL_CHARS = 120_000;
const MAX_DESCRIPTION_CHARS = 6000;

export class VisionError extends Error {
  constructor(message, code = "VISION_FAILED") {
    super(message);
    this.name = "VisionError";
    this.code = code;
  }
}

export function getVisionModel() {
  return process.env.GROQ_VISION_MODEL || DEFAULT_VISION_MODEL;
}

const SYSTEM_PROMPT = [
  "You describe images for a senior software engineer who cannot see them and must change a Git repository based on them.",
  "Be precise, factual and structured. Never invent details you cannot see.",
  "- UI screenshot or design mockup: the page layout from top to bottom (header, sections, footer), each component and how it is arranged (columns, grid, slider, cards, forms), ALL visible text verbatim, colours as approximate hex codes, fonts (serif/sans, weight, size), spacing, borders, shadows, icons, images, and anything that looks broken (overlap, overflow, misalignment, cut-off text).",
  "- Error message, log or code: transcribe the exact text, then say what it indicates.",
  "- Diagram or wireframe: every box, label and connection.",
  "- Logo, photo or illustration: the subject, style and dominant colours (hex), and how it could be used in a website.",
  "Use short headings and bullet points. Stay under 450 words.",
].join("\n");

/** Parse a data URL into { mimeType, bytes } or throw VisionError. */
export function parseImageDataUrl(dataUrl) {
  const match = /^data:([a-z0-9.+/-]+);base64,([a-z0-9+/=\s]+)$/i.exec(String(dataUrl || ""));
  if (!match) throw new VisionError("Each image must be a base64 data URL", "INVALID_IMAGE");
  const mimeType = match[1].toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) {
    throw new VisionError(`Unsupported image type ${mimeType} — use PNG, JPEG, WebP or GIF`, "INVALID_IMAGE");
  }
  const bytes = Math.floor((match[2].replace(/\s/g, "").length * 3) / 4);
  if (bytes > MAX_IMAGE_BYTES) {
    throw new VisionError("Each image must be 4 MB or smaller", "INVALID_IMAGE");
  }
  return { mimeType, bytes };
}

function textOf(content) {
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content.map((part) => (typeof part === "string" ? part : part?.text || "")).join("");
  }
  // Reasoning models may prepend their thinking in <think> tags.
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "");
}

function retryWithNextKey(err) {
  const status = err?.status ?? err?.response?.status;
  return status === 401 || status === 403 || status === 429 || /rate limit|invalid api key/i.test(err?.message || "");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Seconds Groq asks us to wait ("Please try again in 12.5s"), or null. */
function retryAfterSeconds(err) {
  const match = /try again in (?:(\d+)m)?([\d.]+)s/i.exec(err?.message || "");
  if (!match) return null;
  return Number(match[1] || 0) * 60 + Number(match[2]);
}

/** Split "=== IMAGE n ===" sections; null when the reply doesn't have exactly `count`. */
export function splitDescriptions(text, count) {
  if (count === 1) return [text.trim()];
  const parts = text.split(/^\s*=+\s*IMAGE\s+\d+\s*=+\s*$/im).slice(1).map((part) => part.trim());
  return parts.length === count && parts.every(Boolean) ? parts : null;
}

/**
 * Describe several images in ONE vision call (free Groq plans limit output
 * tokens per minute, so one call is far less likely to be rate limited).
 * `apiKeys` are tried in order: an invalid or rate-limited key moves on to
 * the next; when every key is rate limited, waits once as Groq asks (up to a
 * minute). Returns one description per image. `createModel` is injectable for
 * tests, `wait` too.
 */
export async function describeImageSet(
  images,
  instruction,
  { apiKeys, createModel = (options) => new ChatGroq(options), wait = sleep } = {},
) {
  const keys = (apiKeys || []).filter(Boolean);
  if (!keys.length) throw new VisionError("No Groq API key is configured", "LLM_UNAVAILABLE");
  const count = images.length;
  const names = images.map((image, i) => `${i + 1}. ${image.name}`).join("\n");
  const format =
    count === 1
      ? "Stay under 450 words."
      : `Describe each image separately, in order, starting each one with a line "=== IMAGE n ===" (n = 1 to ${count}). Stay under ${Math.max(150, Math.floor(500 / count))} words per image.`;
  const messages = [
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage({
      content: [
        {
          type: "text",
          text: `The user attached ${count === 1 ? "this image" : `these ${count} images`} to the request:\n"""${String(instruction || "").slice(0, 2000)}"""\nImages:\n${names}\n\nDescribe everything in ${count === 1 ? "the image" : "each image"} that matters for implementing that request. ${format}`,
        },
        ...images.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl } })),
      ],
    }),
  ];
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let waitSeconds = null;
    for (const apiKey of keys) {
      const model = createModel({
        apiKey,
        model: getVisionModel(),
        temperature: 0.2,
        // Free-tier Groq plans can cap output at 1000 tokens per minute.
        maxTokens: Number.parseInt(process.env.GROQ_VISION_MAX_TOKENS, 10) || 800,
        maxRetries: 0,
        timeout: 90_000,
      });
      try {
        const reply = await model.invoke(messages);
        const text = textOf(reply?.content).trim();
        if (!text) throw new VisionError("The vision model returned an empty description");
        const parts = splitDescriptions(text, count);
        // Unsplittable reply: every image keeps the combined description.
        return (parts || images.map(() => text)).map((part) => part.slice(0, MAX_DESCRIPTION_CHARS));
      } catch (err) {
        lastError = err;
        if (!retryWithNextKey(err)) break;
        const after = retryAfterSeconds(err);
        if (after !== null) waitSeconds = Math.min(waitSeconds ?? Infinity, after);
      }
    }
    if (attempt === 0 && waitSeconds !== null && waitSeconds <= 60) {
      await wait(Math.ceil(waitSeconds * 1000) + 500);
      continue;
    }
    break;
  }
  const detail = lastError?.message || "unknown error";
  throw new VisionError(`Couldn't read the image(s) with ${getVisionModel()}: ${detail}`);
}

/** Describe a single image (see describeImageSet). */
export async function describeImage({ dataUrl, name, instruction }, options) {
  const [description] = await describeImageSet([{ dataUrl, name: name || "image" }], instruction, options);
  return description;
}

/**
 * Validate and describe the uploaded images ([{ name, dataUrl, thumbnail? }]).
 * Returns the attachments to store on the job: { name, mimeType, size,
 * thumbnail, description } — the full image itself is not kept.
 */
export async function describeImages(images, instruction, options = {}) {
  const list = Array.isArray(images) ? images : [];
  if (!list.length) return [];
  if (list.length > MAX_IMAGES) {
    throw new VisionError(`Attach at most ${MAX_IMAGES} images`, "INVALID_IMAGE");
  }
  const prepared = list.map((image, index) => ({
    ...parseImageDataUrl(image?.dataUrl),
    dataUrl: image.dataUrl,
    name: String(image.name || `image-${index + 1}`).slice(0, 120),
    thumbnail:
      typeof image.thumbnail === "string" &&
      /^data:image\/(png|jpeg|webp);base64,/i.test(image.thumbnail) &&
      image.thumbnail.length <= MAX_THUMBNAIL_CHARS
        ? image.thumbnail
        : null,
  }));
  // Groq accepts at most 4 MB of base64 images in one request.
  if (prepared.reduce((sum, image) => sum + image.dataUrl.length, 0) > MAX_IMAGE_BYTES) {
    throw new VisionError("The images are too large together (4 MB at most) — attach fewer or smaller images", "INVALID_IMAGE");
  }
  const descriptions = await describeImageSet(prepared, instruction, options);
  return prepared.map(({ name, mimeType, bytes, thumbnail }, index) => ({
    name,
    mimeType,
    size: bytes,
    thumbnail,
    description: descriptions[index],
  }));
}
