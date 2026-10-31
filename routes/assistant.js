import express from "express";
import { protect } from "../middleware/auth.js";
import { assistantSchema, validate } from "../middleware/validate.js";
import User from "../models/User.js";
import { resolveCredentials } from "../services/credentials.js";
import { createGroqClient } from "../services/groq.js";

const router = express.Router();

router.post(
  "/improve",
  protect,
  validate(assistantSchema),
  async (req, res) => {
    try {
      const user = await User.findById(req.user._id);
      const { groqKeys } = resolveCredentials(user);

      if (!groqKeys.length) {
        return res.status(502).json({
          message: "No Groq API key configured in settings or server env",
          code: "LLM_UNAVAILABLE",
        });
      }

      const { instruction } = req.body;
      // Switches to the next saved key if one is expired or rate limited.
      const groq = createGroqClient({
        apiKeys: groqKeys,
        timeoutMs: 30000,
        maxRetryWaitMs: 10000,
      });
      const improved = await groq.completeText({
        messages: [
          {
            role: "system",
            content:
              "Rewrite the user's coding instruction to be clearer, more actionable, and specific about files/behavior. Return only the improved instruction text.",
          },
          { role: "user", content: instruction },
        ],
        temperature: 0.3,
        maxTokens: 1024,
      });

      if (!improved) {
        return res.status(502).json({
          message: "Assistant returned an empty response",
          code: "LLM_EMPTY",
        });
      }

      res.json({ improvedInstruction: improved });
    } catch (err) {
      res.status(502).json({
        message: err.message || "Assistant failed",
        code: "LLM_FAILED",
      });
    }
  },
);

export default router;
