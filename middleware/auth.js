import jwt from "jsonwebtoken";
import User from "../models/User.js";

const getJwtSecret = () => process.env.JWT_SECRET || "secret";

export const AUTH_COOKIE = "rm_token";

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

// Accept either an `Authorization: Bearer` header or the httpOnly session cookie.
function getToken(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) return auth.split(" ")[1];
  return readCookie(req, AUTH_COOKIE);
}

export const protect = async (req, res, next) => {
  const token = getToken(req);
  if (!token) {
    return res.status(401).json({ message: "Not authorized", code: "UNAUTHORIZED" });
  }
  try {
    const decoded = jwt.verify(token, getJwtSecret());
    req.user = await User.findById(decoded.id).select("-password");
    if (!req.user) {
      return res.status(401).json({ message: "User not found", code: "UNAUTHORIZED" });
    }
    next();
  } catch {
    res.status(401).json({ message: "Token invalid", code: "UNAUTHORIZED" });
  }
};
