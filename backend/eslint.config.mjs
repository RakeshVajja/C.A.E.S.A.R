import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// Mirrors the TypeScript rules the frontend gets from eslint-config-next/typescript
// (typescript-eslint recommended + the same two warnings), minus the React/Next rules.
const eslintConfig = defineConfig([
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
    },
  },
  // Backend-only, type-aware: an unawaited promise can hide a failed write.
  // Type information comes from tsconfig.json, which covers src, tests, prisma and scripts.
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  globalIgnores(["dist/**", "coverage/**"]),
]);

export default eslintConfig;
