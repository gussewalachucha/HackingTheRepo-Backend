import { z } from "zod";
import { branchNameProblem } from "../services/branchName.js";
import { parseRepoUrl } from "../services/github.js";

const MAX_INSTRUCTION_LENGTH = 10000;

// The frontend sends "" for an untouched optional field: treat it as absent.
const blankToUndefined = (value) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

export const signupSchema = z.object({
  username: z.string().trim().min(2).max(64),
  email: z.string().trim().email(),
  password: z.string().min(6).max(128),
});

export const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

export const settingsSchema = z.object({
  githubUsername: z.string().trim().max(128).optional(),
  githubToken: z.string().max(512).optional(),
  // One or more Groq keys, separated by new lines or commas.
  groqKey: z.string().max(4096).optional(),
  clearGroqKeys: z.boolean().optional(),
});

// Images attached to a request; the data URLs are checked in services/vision.js.
const imagesSchema = z
  .array(
    z.object({
      name: z.string().trim().max(200).optional(),
      dataUrl: z.string().min(1),
      thumbnail: z.string().optional(),
    }),
  )
  .max(4, "Attach at most 4 images")
  .optional();

export const createJobSchema = z.object({
  repoUrl: z
    .string()
    .trim()
    .url()
    .superRefine((value, ctx) => {
      try {
        parseRepoUrl(value);
      } catch (err) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: err.message });
      }
    }),
  instruction: z.string().trim().min(1).max(MAX_INSTRUCTION_LENGTH),
  branchName: z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .max(120)
      .superRefine((value, ctx) => {
        const problem = branchNameProblem(value);
        if (problem) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
        }
      })
      .optional(),
  ),
  prTitle: z.string().trim().max(200).optional(),
  previewBeforePush: z.boolean().optional(),
  images: imagesSchema,
});

export const refineSchema = z.object({
  instruction: z.string().trim().min(1).max(MAX_INSTRUCTION_LENGTH),
  images: imagesSchema,
});

export const assistantSchema = z.object({
  instruction: z.string().trim().min(1),
});

export const githubCallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().optional(),
  redirectUri: z.string().url().optional(),
});

export function validate(schema) {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: parsed.error.errors[0]?.message || "Invalid request body",
        code: "VALIDATION_ERROR",
        details: parsed.error.flatten(),
      });
    }
    req.body = parsed.data;
    next();
  };
}
