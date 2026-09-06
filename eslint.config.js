import js from "@eslint/js"
import tseslint from "typescript-eslint"

export default tseslint.config(
  // src/app-ui/*.js is plain browser JS shipped as a static asset, not part of the Node/TS
  // project -- no type-checking project applies to it.
  { ignores: ["node_modules/", ".tmp/", "eslint.config.js", "src/app-ui/"] },
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
