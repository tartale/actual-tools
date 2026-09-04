import js from "@eslint/js"
import tseslint from "typescript-eslint"

export default tseslint.config(
  { ignores: ["node_modules/", ".tmp/", "eslint.config.js"] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    // Test doubles are `async` to satisfy the interface they stand in for
    // (fetch, Response.json), so having no `await` is the point, not a slip.
    files: ["**/*.test.ts"],
    rules: { "@typescript-eslint/require-await": "off" },
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
)
