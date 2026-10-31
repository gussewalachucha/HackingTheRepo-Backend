import express from "express";
import User from "../models/User.js";
import { protect } from "../middleware/auth.js";
import { settingsSchema, validate } from "../middleware/validate.js";
import { decryptSecret, encryptSecret, maskSecret } from "../utils/crypto.js";
import { userGroqKeys } from "../services/credentials.js";
import { parseApiKeys } from "../services/groq.js";

const router = express.Router();
const MAX_GROQ_KEYS = 10;

const maskKey = (key) => "••••••••••••" + key.slice(-4);

// GET /api/settings
router.get("/", protect, async (req, res) => {
  const user = await User.findById(req.user._id);
  const githubToken = decryptSecret(user.githubToken);
  const groqKeys = userGroqKeys(user);

  res.json({
    githubUsername: user.githubUsername,
    githubToken: githubToken ? maskSecret(user.githubToken) : "",
    groqKey: groqKeys.length ? maskKey(groqKeys[0]) : "",
    // Masked, in the order they are used.
    groqKeys: groqKeys.map(maskKey),
    hasGithubToken: !!githubToken,
    hasGroqKey: groqKeys.length > 0,
  });
});

// PUT /api/settings
router.put("/", protect, validate(settingsSchema), async (req, res) => {
  try {
    const { githubUsername, githubToken, groqKey, clearGroqKeys } = req.body;
    const update = {};
    if (githubUsername !== undefined) update.githubUsername = githubUsername;
    if (githubToken && !githubToken.startsWith("••")) {
      update.githubToken = encryptSecret(githubToken);
    }
    // New keys are added after the saved ones (duplicates ignored), so a
    // backup key can be added without re-entering the others.
    const newKeys = parseApiKeys(groqKey).filter((key) => !key.startsWith("••"));
    if (clearGroqKeys || newKeys.length) {
      const current = await User.findById(req.user._id);
      const keys = parseApiKeys(clearGroqKeys ? [] : userGroqKeys(current), newKeys);
      if (keys.length > MAX_GROQ_KEYS) {
        return res.status(400).json({
          message: `You can save up to ${MAX_GROQ_KEYS} Groq keys`,
          code: "VALIDATION_ERROR",
        });
      }
      update.groqKey = keys.length ? encryptSecret(keys.join("\n")) : "";
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({
        message: "No settings fields to update",
        code: "VALIDATION_ERROR",
      });
    }

    const user = await User.findByIdAndUpdate(req.user._id, update, {
      new: true,
    });
    res.json({
      message: "Settings updated",
      githubUsername: user.githubUsername,
      groqKeyCount: userGroqKeys(user).length,
    });
  } catch (err) {
    res.status(500).json({ message: err.message, code: "INTERNAL_ERROR" });
  }
});

export default router;
