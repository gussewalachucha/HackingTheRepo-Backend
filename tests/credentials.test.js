import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileGroqKeys, resolveCredentials } from "../services/credentials.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "groq-keys-"));
const write = (name, text) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
};

const testKeysFile = process.env.GROQ_KEYS_FILE;

afterEach(() => {
  process.env.GROQ_KEYS_FILE = testKeysFile;
  delete process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEYS;
});

describe("Groq keys file", () => {
  it("reads keys from an object, an array or nested lists", () => {
    expect(fileGroqKeys(write("obj.json", '{"0":"gsk_a","1":"gsk_b"}'))).toEqual(["gsk_a", "gsk_b"]);
    expect(fileGroqKeys(write("arr.json", '["gsk_a", " gsk_c ", "gsk_a"]'))).toEqual(["gsk_a", "gsk_c"]);
    expect(fileGroqKeys(write("nested.json", '{"keys":["gsk_d"],"note":"not a key"}'))).toEqual(["gsk_d"]);
  });

  it("ignores a missing or invalid file", () => {
    expect(fileGroqKeys(path.join(dir, "missing.json"))).toEqual([]);
    expect(fileGroqKeys(write("bad.json", "{oops"))).toEqual([]);
  });

  it("adds file keys after the env keys", () => {
    process.env.GROQ_API_KEY = "gsk_env";
    process.env.GROQ_KEYS_FILE = write("jobs.json", '["gsk_file1","gsk_env"]');
    expect(resolveCredentials(null).groqKeys).toEqual(["gsk_env", "gsk_file1"]);
  });
});
