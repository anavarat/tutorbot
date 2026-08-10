import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

const workerGlobals = {
  Request: "readonly",
  Response: "readonly",
  console: "readonly",
};

const nodeGlobals = {
  console: "readonly",
  process: "readonly",
};

export default defineConfig(
  globalIgnores([
    "**/node_modules/**",
    "**/.wrangler/**",
    "coverage/**",
    "dist/**",
  ]),
  {
    files: ["apps/**/*.ts", "packages/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },
  {
    files: ["apps/worker/src/**/*.ts"],
    languageOptions: {
      globals: workerGlobals,
    },
  },
  {
    files: ["apps/worker/src/container/main.ts"],
    languageOptions: {
      globals: nodeGlobals,
    },
  },
  {
    files: ["apps/worker/src/**/*.test.ts"],
    languageOptions: {
      globals: {
        ...workerGlobals,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
