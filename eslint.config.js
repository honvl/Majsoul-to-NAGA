const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  { ignores: ["node_modules/", "test/fixtures/", "index.js"] },
  js.configs.recommended,
  {
    // The userscript runs in the browser with Tampermonkey GM_* APIs.
    files: ["downloadlogsnaga.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        unsafeWindow: "readonly",
        GM_xmlhttpRequest: "readonly",
        GM_cookie: "readonly",
      },
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
    },
  },
  {
    files: ["test/**/*.cjs", "*.config.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "commonjs", globals: { ...globals.node } },
  },
];
