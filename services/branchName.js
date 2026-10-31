// Branch-name helpers shared by request validation, the job routes and the
// git service. The final authority is `git check-ref-format --branch`, which
// the pipeline runs before creating a branch; this module mirrors the git
// rules (plus a conservative charset) so bad names fail fast with a 400.

const ALLOWED = /^[A-Za-z0-9._/-]+$/;
export const MAX_BRANCH_LENGTH = 120;

/** Returns a human-readable problem with `name`, or null when it is valid. */
export function branchNameProblem(name) {
  if (typeof name !== "string" || name.length === 0) {
    return "Branch name is required";
  }
  if (name.length > MAX_BRANCH_LENGTH) {
    return `Branch name must be at most ${MAX_BRANCH_LENGTH} characters`;
  }
  if (/\s/.test(name)) return "Branch name can't contain spaces";
  if (name.startsWith("-")) return "Branch name can't start with '-'";
  if (!ALLOWED.test(name)) {
    return "Branch name may only contain letters, numbers, '.', '_', '-' and '/'";
  }
  if (name === "HEAD") return "Branch name can't be HEAD";
  if (name.startsWith("/") || name.endsWith("/")) {
    return "Branch name can't start or end with '/'";
  }
  if (name.includes("//")) return "Branch name can't contain '//'";
  if (name.includes("..")) return "Branch name can't contain '..'";
  if (name.endsWith(".")) return "Branch name can't end with '.'";
  for (const part of name.split("/")) {
    if (part.startsWith(".")) {
      return "Branch name segments can't start with '.'";
    }
    if (part.endsWith(".lock")) {
      return "Branch name segments can't end with '.lock'";
    }
  }
  return null;
}

export function isValidBranchName(name) {
  return branchNameProblem(name) === null;
}

/**
 * The historical default: "Add unit tests!" -> "repomind/add-unit-tests".
 * Same algorithm as the frontend's autoSlug. Returns "" when nothing usable
 * is left (e.g. a non-Latin instruction) so callers can fall back.
 */
export function slugBranchName(instruction) {
  const slug = String(instruction || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 50);
  const name = `repomind/${slug}`;
  return slug && isValidBranchName(name) ? name : "";
}
